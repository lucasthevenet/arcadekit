import { readFileSync } from "node:fs";

import {
  HeroLeft,
  LeveledUp,
  RunEnded,
  SurvivorsContent,
} from "@arcadekit/survivors";
import type { GameContent, Survivors } from "@arcadekit/survivors";
import {
  SurvivorsCoop,
  SurvivorsCueTable,
  SurvivorsSheet,
} from "@arcadekit/survivors/browser";
import { AudioSystem } from "arcadekit/audio";
import { ContentSource } from "arcadekit/content";
import type * as Game from "arcadekit/game";
import { Frames } from "arcadekit/game/browser";
import { manualFrames } from "arcadekit/game/testing";
import {
  LobbyChanged,
  RunStarted,
  SeatFailed,
  WaitingChanged,
} from "arcadekit/net/browser";
import type { CoopEvent } from "arcadekit/net/browser";
import {
  FAKE_JOIN_CODE,
  fakeCoopRooms,
  onFakeTimers,
} from "arcadekit/net/testing";
import type { FakeCoopRooms } from "arcadekit/net/testing";
import { SpriteSheetError } from "arcadekit/render-three";
import type { SpriteSheet } from "arcadekit/render-three";
import { Context, Deferred, Effect, Exit, Layer, Scope } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ChooseCoopUpgrade,
  HostCoop,
  LeaveCoop,
  SetCoopPaused,
} from "./commands";
import { CoopLayer } from "./coop";
import type { CoopDebugSample } from "./coop";
import { Message } from "./message";
import { emptyHud } from "./model";
import { survivorsSounds } from "./sound";
import { coopMessage } from "./subscriptions";

// The app's co-op glue with nothing real behind it: the kit's fake rooms stand in for the
// signalling worker and WebRTC, the content is the app's own files, and nothing draws. The
// Co-op client itself is tested in arcadekit/net/browser, and survivors' rules in its package.

const contentDir = new URL("../../public/content/", import.meta.url);
const fileSource = ContentSource.make((file) =>
  Effect.try({
    try: () =>
      JSON.parse(readFileSync(new URL(file, contentDir), "utf-8")) as unknown,
    catch: (cause) =>
      new ContentSource.ContentError({ message: String(cause), cause }),
  })
);

const content: GameContent = await Effect.runPromise(
  SurvivorsContent.read(fileSource)
);

type SheetLoad = Effect.Effect<SpriteSheet, SpriteSheetError>;

/** A sheet whose load never finishes: building the layer loads nothing. */
const idleSheet: SheetLoad = Effect.never;

/** A sheet that has loaded, which nothing reads. */
const loadedSheet: SheetLoad = Effect.succeed({} as SpriteSheet);

let scope: Scope.Closeable;

/**
 * Runs `effect` as the app does, on the test's Clock and Scheduler: the faked time, and fibers
 * on microtasks.
 */
const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(onFakeTimers(effect));

interface Seat {
  readonly coop: Context.Service.Shape<typeof SurvivorsCoop>;
  readonly context: Context.Context<SurvivorsCoop>;
}

/** The app's co-op layer over `hub`, in the test's scope. */
const seat = async (
  hub: FakeCoopRooms,
  parts: {
    readonly sheet?: SheetLoad;
    readonly load?: Effect.Effect<GameContent, ContentSource.ContentError>;
  } = {}
): Promise<Seat> => {
  const layer = CoopLayer.pipe(
    Layer.provide(hub.layer),
    Layer.provide(Layer.succeed(Frames, manualFrames())),
    Layer.provide(AudioSystem.layerSilent),
    Layer.provide(SurvivorsCueTable.layer(survivorsSounds)),
    Layer.provide(
      Layer.succeed(SurvivorsSheet, { load: parts.sheet ?? idleSheet })
    ),
    Layer.provide(
      Layer.succeed(SurvivorsContent, {
        load: parts.load ?? Effect.succeed(content),
      })
    )
  );
  const context = await run(Layer.buildWithScope(layer, scope));
  return { coop: Context.get(context, SurvivorsCoop), context };
};

type Event = CoopEvent<Game.EventOf<typeof Survivors>>;

const listen = async ({ coop }: Seat): Promise<Event[]> => {
  const events: Event[] = [];
  await run(
    Scope.provide(
      coop.listen((event) => events.push(event)),
      scope
    )
  );
  return events;
};

/** Lets queued microtasks run, at the current fake time. */
const settle = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

/** How a run ended for the hero `heroId`. */
const summary = (heroId: string) => ({
  won: true,
  heroId,
  heroName: heroId,
  time: 90,
  kills: 12,
  level: 3,
});

const debugGlobal = (): CoopDebugSample =>
  (
    globalThis as unknown as {
      arcadekitCoop: { debug: () => CoopDebugSample };
    }
  ).arcadekitCoop.debug();

describe("the app's co-op", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "performance"],
    });
    scope = Effect.runSync(Scope.make());
  });

  afterEach(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("the co-op layer", () => {
    it("leaves the room and removes its debug global when the app's scope closes", async () => {
      const hub = fakeCoopRooms();
      const { coop } = await seat(hub);
      await run(coop.host("spark"));
      await settle();
      const whileOpen = ["arcadekitCoop" in globalThis, [...hub.log]];
      await Effect.runPromise(Scope.close(scope, Exit.void));
      expect({
        whileOpen,
        afterClose: ["arcadekitCoop" in globalThis, hub.log],
      }).toStrictEqual({
        whileOpen: [true, ["open host"]],
        afterClose: [false, ["open host", "release host"]],
      });
    });

    it("plays survivors for two: a lobby of heroes, the same run on both, and a debug read that is plain data", async () => {
      const hub = fakeCoopRooms();
      const host = await seat(hub);
      const hostEvents = await listen(host);
      const guest = await seat(hub);
      const guestEvents = await listen(guest);
      await run(host.coop.host("spark"));
      await settle();
      await run(guest.coop.join(FAKE_JOIN_CODE, "ember"));
      await settle();
      await run(guest.coop.choose("tide"));
      await settle();
      const players = [
        { id: "host", name: "Host", pick: "spark" },
        { id: "guest-1", name: "Guest 1", pick: "tide" },
      ];
      const lobby = {
        code: FAKE_JOIN_CODE,
        players,
        maxPlayers: 4,
        canStart: true,
      };
      expect([
        hostEvents.findLast((event) => event._tag === "LobbyChanged"),
        guestEvents.findLast((event) => event._tag === "LobbyChanged"),
      ]).toStrictEqual([
        new LobbyChanged({ ...lobby, role: "host", self: "host" }),
        new LobbyChanged({ ...lobby, role: "guest", self: "guest-1" }),
      ]);

      await run(host.coop.start);
      await vi.advanceTimersByTimeAsync(5000);
      const [hostRun, guestRun] = [host.coop.debug(), guest.coop.debug()];
      const common = Object.keys(hostRun.hashes).filter(
        (step) => step in guestRun.hashes
      );
      // The last layer built owns the global: the guest's.
      const sample = debugGlobal();
      expect({
        started: [hostEvents, guestEvents].map((events) =>
          events.find((event) => event._tag === "RunStarted")
        ),
        heroes: guestRun.state?.heroes.map((hero) => hero.def.id),
        errors: [hostRun.error, guestRun.error],
        stepped: hostRun.stepIndex > 200,
        hashed: common.length > 2,
        hostHashes: common.map((step) => hostRun.hashes[Number(step)]),
        hud: guestEvents.some(
          (event) => event._tag === "RunEvent" && event.event._tag === "Hud"
        ),
        sample: structuredClone(sample),
      }).toStrictEqual({
        started: [
          new RunStarted({ slot: 0, names: ["Host", "Guest 1"] }),
          new RunStarted({ slot: 1, names: ["Host", "Guest 1"] }),
        ],
        heroes: ["spark", "tide"],
        errors: [null, null],
        stepped: true,
        hashed: true,
        hostHashes: common.map((step) => guestRun.hashes[Number(step)]),
        hud: true,
        sample: {
          stepIndex: sample.stepIndex,
          error: null,
          hashes: sample.hashes,
          slot: 1,
          level: guestRun.state?.level,
          time: guestRun.state?.time,
        },
      });
    });

    it("refuses a start whose hero the guest's content doesn't have", async () => {
      const hub = fakeCoopRooms();
      const host = await seat(hub);
      // The guest's game lacks the host's hero: an older build's content, say.
      const guest = await seat(hub, {
        load: Effect.succeed({
          ...content,
          // Every hero but the first, "spark".
          heroes: [content.heroes[1]!, ...content.heroes.slice(2)],
        }),
      });
      const guestEvents = await listen(guest);
      await run(host.coop.host("spark"));
      await settle();
      await run(guest.coop.join(FAKE_JOIN_CODE, "ember"));
      await settle();
      await run(host.coop.start);
      await vi.advanceTimersByTimeAsync(100);
      const failed = guestEvents.find((event) => event._tag === "SeatFailed");
      expect({
        reason: failed?._tag === "SeatFailed" && failed.reason,
        started: guestEvents.some((event) => event._tag === "RunStarted"),
        shown: failed && coopMessage(failed)?._tag,
      }).toStrictEqual({
        reason: "unknownPick",
        started: false,
        shown: "GotCoopFailed",
      });
    });
  });

  describe("the co-op Commands", () => {
    it("open no room when Leave comes while Host waits on the content", async () => {
      const hub = fakeCoopRooms();
      const loaded = Effect.runSync(
        Deferred.make<GameContent, ContentSource.ContentError>()
      );
      const { context } = await seat(hub, { load: Deferred.await(loaded) });
      // Foldkit runs each Command in Message order: Host, then Leave.
      const command = <A>(effect: Effect.Effect<A, never, SurvivorsCoop>) =>
        run(Effect.provideContext(effect, context));
      await command(HostCoop({ heroId: "spark" }).effect);
      await command(LeaveCoop().effect);
      await Effect.runPromise(Deferred.succeed(loaded, content));
      await settle();
      await Effect.runPromise(Scope.close(scope, Exit.void));
      expect(hub.log).toStrictEqual([]);
    });

    it("hold the run paused on every page with the genre's command, and say when the run holds no pause", async () => {
      const hub = fakeCoopRooms();
      const host = await seat(hub);
      const guest = await seat(hub);
      const command = <A>(
        player: Seat,
        effect: Effect.Effect<A, never, SurvivorsCoop>
      ) => run(Effect.provideContext(effect, player.context));
      const pause = (player: Seat, paused: boolean) =>
        command(player, SetCoopPaused({ paused }).effect);
      const clocks = () =>
        [host, guest].map(({ coop }) => coop.debug().state?.time);
      // With no run, there is nothing to hold: the app's toggle is told so.
      const early = await pause(host, true);
      await run(host.coop.host("spark"));
      await settle();
      await run(guest.coop.join(FAKE_JOIN_CODE, "ember"));
      await settle();
      await run(host.coop.start);
      await vi.advanceTimersByTimeAsync(1000);
      const held = pause(guest, true);
      await vi.advanceTimersByTimeAsync(1000);
      const [stopped, steps] = [clocks(), host.coop.debug().stepIndex];
      const heldBy = [host, guest].map(({ coop }) =>
        coop.debug().state?.heroes.map((hero) => hero.paused)
      );
      await vi.advanceTimersByTimeAsync(1000);
      const [stillStopped, stepsLater] = [
        clocks(),
        host.coop.debug().stepIndex,
      ];
      const released = pause(guest, false);
      await vi.advanceTimersByTimeAsync(1000);
      expect({
        early,
        held: await held,
        // The guest's hero holds it, on both pages, and the run's clock stands on both.
        heldBy,
        stopped: [stopped[0] === stopped[1], stillStopped],
        // A paused run still steps, so the pages stay in touch.
        stepping: stepsLater > steps,
        released: await released,
        resumed: clocks().map((time) => (time ?? 0) > (stopped[0] ?? 0)),
      }).toStrictEqual({
        early: Message.FailedToHoldCoopPause(),
        held: Message.CompletedEngineCommand(),
        heldBy: [
          [false, true],
          [false, true],
        ],
        stopped: [true, stopped],
        stepping: true,
        released: Message.CompletedEngineCommand(),
        resumed: [true, true],
      });
    });

    it("end a pick the same way however the run answers it: with no run, and for an offer that isn't open", async () => {
      const hub = fakeCoopRooms();
      const host = await seat(hub);
      const guest = await seat(hub);
      const pick = (player: Seat) =>
        run(
          Effect.provideContext(
            ChooseCoopUpgrade({ offer: 1, index: 0 }).effect,
            player.context
          )
        );
      const noRun = await pick(host);
      await run(host.coop.host("spark"));
      await settle();
      await run(guest.coop.join(FAKE_JOIN_CODE, "ember"));
      await settle();
      await run(host.coop.start);
      await vi.advanceTimersByTimeAsync(1000);
      // No offer is open a second into a run: the rules refuse the pick, on both pages alike.
      const refused = pick(guest);
      await vi.advanceTimersByTimeAsync(1000);
      expect([
        noRun,
        await refused,
        [host.coop.debug().error, guest.coop.debug().error],
      ]).toStrictEqual([
        Message.CompletedEngineCommand(),
        Message.CompletedEngineCommand(),
        [null, null],
      ]);
    });
  });

  describe("attaching co-op", () => {
    const element = Object.assign(new EventTarget(), {
      style: {},
    }) as unknown as HTMLElement;

    beforeEach(() => {
      vi.stubGlobal("window", new EventTarget());
    });

    it("fails with an AttachError where it can't draw, as here with no WebGL, after leaving its room", async () => {
      const hub = fakeCoopRooms();
      const { coop } = await seat(hub, { sheet: loadedSheet });
      await run(coop.host("spark"));
      await settle();
      const error = await run(Effect.flip(coop.attach(element)));
      expect([error._tag, hub.log]).toStrictEqual([
        "AttachError",
        ["open host", "release host"],
      ]);
    });

    it("fails with the sheet's error when the sheet can't load", async () => {
      const missing = new SpriteSheetError({
        file: "sprites/survivors.json",
        message: "The sheet can't be loaded",
      });
      const { coop } = await seat(fakeCoopRooms(), {
        sheet: Effect.fail(missing),
      });
      const error = await run(Effect.flip(coop.attach(element)));
      expect(error).toBe(missing);
    });
  });

  describe("co-op events as Messages", () => {
    const local = { slot: 1, names: ["Host", "Guest 1"] };
    /** One of the run's events, as the seat at slot 1 hears it. */
    const heard = (event: Game.EventOf<typeof Survivors>): Event => ({
      _tag: "RunEvent",
      event,
      local,
    });

    it("passes the client's own events on: the lobby as it is, the start, who it waits for, a failure's text", () => {
      const lobby = new LobbyChanged({
        role: "host",
        code: FAKE_JOIN_CODE,
        self: "host",
        players: [{ id: "host", name: "Host", pick: "spark" }],
        maxPlayers: 4,
        canStart: false,
      });
      const events: Event[] = [
        lobby,
        new RunStarted({ slot: 1, names: ["Host", "Guest 1"] }),
        new WaitingChanged({ waitingFor: ["Host"] }),
        new SeatFailed({ reason: "hostLost", message: "Lost the host." }),
      ];
      expect(events.map(coopMessage)).toStrictEqual([
        Message.GotCoopLobby({ lobby }),
        Message.GotCoopStarted({ slot: 1, names: ["Host", "Guest 1"] }),
        Message.GotCoopWaiting({ waitingFor: ["Host"] }),
        Message.GotCoopFailed({ error: "Lost the host." }),
      ]);
    });

    it("tells the local player the HUD, its own hero's offer and its own summary, and no other hero's", () => {
      const events: Event[] = [
        heard(emptyHud),
        heard(new LeveledUp({ hero: 0, offer: 2, choices: [] })),
        heard(new LeveledUp({ hero: 1, offer: 2, choices: [] })),
        heard(new HeroLeft({ hero: 0 })),
        heard(new RunEnded({ summaries: [summary("spark"), summary("tide")] })),
        // A run this seat has no hero in: there is no summary to show.
        heard(new RunEnded({ summaries: [summary("spark")] })),
      ];
      expect(events.map(coopMessage)).toStrictEqual([
        Message.GotHud({ hud: emptyHud }),
        undefined,
        Message.GotCoopLevelUp({ offer: 2, choices: [] }),
        undefined,
        Message.GotCoopRunEnded({ summary: summary("tide") }),
        undefined,
      ]);
    });
  });
});
