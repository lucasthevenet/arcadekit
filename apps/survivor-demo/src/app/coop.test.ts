import { readFileSync } from "node:fs";

import { SurvivorsContent } from "@arcadekit/survivors";
import type { GameContent, SurvivorsCoopEvent } from "@arcadekit/survivors";
import { SurvivorsSheet } from "@arcadekit/survivors/browser";
import { SilentAudioLayer } from "arcadekit/audio";
import { ContentError } from "arcadekit/content";
import type { ContentSource } from "arcadekit/content";
import type { CoopEvent } from "arcadekit/net/browser";
import { FAKE_JOIN_CODE, fakeCoopRooms } from "arcadekit/net/testing";
import type { FakeCoopRooms } from "arcadekit/net/testing";
import { SpriteSheetError } from "arcadekit/render-three";
import type { SpriteSheet } from "arcadekit/render-three";
import { manualFrames } from "arcadekit/runtime/testing";
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Scheduler,
  Scope,
} from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostCoop, LeaveCoop } from "./commands";
import { Coop, makeCoopLayer } from "./coop";
import type { CoopApi, CoopDebugSample } from "./coop";
import { Message } from "./message";
import { emptyHud } from "./model";
import { coopMessage } from "./subscriptions";

// The app's co-op glue with nothing real behind it: the kit's fake rooms stand in for the
// signalling worker and WebRTC, the content is the app's own files, and nothing draws. The
// Co-op client itself is tested in arcadekit/net/browser, and survivors' rules in its package.

const contentDir = new URL("../../public/content/", import.meta.url);
const fileSource: ContentSource = (file) =>
  Effect.try({
    try: () =>
      JSON.parse(readFileSync(new URL(file, contentDir), "utf-8")) as unknown,
    catch: (cause) => new ContentError({ message: String(cause) }),
  });

const content: GameContent = await Effect.runPromise(
  SurvivorsContent.read(fileSource)
);

type SheetLoad = Effect.Effect<SpriteSheet, SpriteSheetError>;

/** A sheet whose load never finishes: building the layer loads nothing. */
const idleSheet: SheetLoad = Effect.never;

/** A sheet that has loaded, which nothing reads. */
const loadedSheet: SheetLoad = Effect.succeed({} as SpriteSheet);

const nanos = (ms: number) => BigInt(Math.round(ms * 1_000_000));

/** Effect's Clock on the page's timers, which the tests fake. */
const performanceClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => Date.now(),
  currentTimeMillis: Effect.sync(() => Date.now()),
  currentTimeNanosUnsafe: () => nanos(Date.now()),
  currentTimeNanos: Effect.sync(() => nanos(Date.now())),
  monotonicTimeNanosUnsafe: () => nanos(performance.now()),
  monotonicTimeNanos: Effect.sync(() => nanos(performance.now())),
  sleep: (duration) =>
    Effect.callback((resume) => {
      const timer = setTimeout(
        () => resume(Effect.void),
        Duration.toMillis(duration)
      );
      return Effect.sync(() => clearTimeout(timer));
    }),
};

/** Runs fibers on microtasks, as Foldkit's browser scheduler does. */
const microtasks = new Scheduler.MixedScheduler("async", (task) => {
  let cancelled = false;
  queueMicrotask(() => {
    if (!cancelled) {
      task();
    }
  });
  return () => {
    cancelled = true;
  };
});

let scope: Scope.Closeable;

/** Runs `effect` as the app does, on the test's Clock and Scheduler. */
const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(Clock.Clock, performanceClock),
      Effect.provideService(Scheduler.Scheduler, microtasks)
    )
  );

interface Seat {
  readonly coop: CoopApi;
  readonly context: Context.Context<Coop>;
}

/** The app's co-op layer over `hub`, in the test's scope. */
const seat = async (
  hub: FakeCoopRooms,
  parts: {
    readonly sheet?: SheetLoad;
    readonly load?: Effect.Effect<GameContent, ContentError>;
  } = {}
): Promise<Seat> => {
  const layer = makeCoopLayer(() => hub.rooms, {
    frames: manualFrames(),
  }).pipe(
    Layer.provide(SilentAudioLayer),
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
  return { coop: Context.get(context, Coop), context };
};

type Event = CoopEvent<SurvivorsCoopEvent>;

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
        type: "lobby",
        code: FAKE_JOIN_CODE,
        players,
        maxPlayers: 4,
        canStart: true,
      };
      expect([
        hostEvents.findLast((event) => event.type === "lobby"),
        guestEvents.findLast((event) => event.type === "lobby"),
      ]).toStrictEqual([
        { ...lobby, role: "host", self: "host" },
        { ...lobby, role: "guest", self: "guest-1" },
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
          events.find((event) => event.type === "started")
        ),
        heroes: guestRun.state?.heroes.map((hero) => hero.def.id),
        errors: [hostRun.error, guestRun.error],
        stepped: hostRun.stepIndex > 200,
        hashed: common.length > 2,
        hostHashes: common.map((step) => hostRun.hashes[Number(step)]),
        hud: guestEvents.some(
          (event) => event.type === "run" && event.event.type === "hud"
        ),
        sample: structuredClone(sample),
      }).toStrictEqual({
        started: [
          { type: "started", slot: 0, names: ["Host", "Guest 1"] },
          { type: "started", slot: 1, names: ["Host", "Guest 1"] },
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
      const failed = guestEvents.find((event) => event.type === "failed");
      expect({
        reason: failed?.type === "failed" && failed.reason,
        started: guestEvents.some((event) => event.type === "started"),
        shown: failed && coopMessage(failed)._tag,
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
      const loaded = Effect.runSync(Deferred.make<GameContent, ContentError>());
      const { context } = await seat(hub, { load: Deferred.await(loaded) });
      // Foldkit runs each Command in Message order: Host, then Leave.
      const command = <A>(effect: Effect.Effect<A, never, Coop>) =>
        run(Effect.provideContext(effect, context));
      await command(HostCoop({ heroId: "spark" }).effect);
      await command(LeaveCoop().effect);
      await Effect.runPromise(Deferred.succeed(loaded, content));
      await settle();
      await Effect.runPromise(Scope.close(scope, Exit.void));
      expect(hub.log).toStrictEqual([]);
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
    it("passes the lobby as the client reports it, and unwraps the run's events", () => {
      const players = [{ id: "host", name: "Host", pick: "spark" }];
      const lobby = {
        role: "host" as const,
        code: FAKE_JOIN_CODE,
        self: "host",
        players,
        maxPlayers: 4,
        canStart: false,
      };
      const summary = {
        won: true,
        heroId: "spark",
        heroName: "Spark",
        time: 90,
        kills: 12,
        level: 3,
      };
      const events: Event[] = [
        { type: "lobby", ...lobby },
        { type: "started", slot: 1, names: ["Host", "Guest 1"] },
        { type: "waiting", waitingFor: ["Host"], choosing: ["Guest 2"] },
        { type: "run", event: { type: "hud", hud: emptyHud } },
        { type: "run", event: { type: "levelUp", offer: 2, choices: [] } },
        { type: "run", event: { type: "runEnded", summary } },
        { type: "failed", reason: "hostLost", message: "Lost the host." },
      ];
      expect(events.map(coopMessage)).toStrictEqual([
        Message.GotCoopLobby(lobby),
        Message.GotCoopStarted({ slot: 1, names: ["Host", "Guest 1"] }),
        Message.GotCoopWaiting({ waitingFor: ["Host"], choosing: ["Guest 2"] }),
        Message.GotHud({ hud: emptyHud }),
        Message.GotCoopLevelUp({ offer: 2, choices: [] }),
        Message.GotCoopRunEnded({ summary }),
        Message.GotCoopFailed({ error: "Lost the host." }),
      ]);
    });
  });
});
