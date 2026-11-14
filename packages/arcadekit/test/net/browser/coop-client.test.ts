import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Result,
  Scope,
  Stream,
} from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AttachError, GameCrashed } from "../../../src/game/browser";
import { CommandDropped } from "../../../src/game/index";
import { ManualFrames } from "../../../src/game/testing/index";
import {
  CoopEvent,
  CoopRooms,
  PeerLink,
  SignallingRoom,
} from "../../../src/net/browser/index";
import type { Ticker } from "../../../src/net/index";
import { encodeLobbyMessage } from "../../../src/net/internal/lobby";
import {
  FakeCoopRooms,
  ManualTicker,
  PageTimers,
  TestGame,
} from "../../../src/net/testing/index";
import {
  testCoopClient,
  testCoopParts,
  testPresentation,
} from "./internal/test-client";
import type {
  TestCoopClient,
  TestCoopOptions,
  TestCoopParts,
} from "./internal/test-client";

/** `effect` on the page's timers, as a test on fake timers runs each of its Effects. */
const onPage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(PageTimers.layer));

/**
 * The reasons an exit failed with, each a `Fail`'s error or the reason itself. The frame loop the
 * client draws on is traced, so a crash carries its span as an annotation, which this leaves out.
 */
const failures = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit)
    ? "succeeded"
    : exit.cause.reasons.map((reason) =>
        Cause.isFailReason(reason) ? reason.error : reason
      );

// The Co-op client in Node, with no browser, playing the test game (`arcadekit/net/testing`)
// from plain parts (test-client.ts), so a test can replace any of them: a fake signalling hub
// links the host to each guest with in-memory channels, and fake timers drive the clients'
// tickers. Nothing is attached unless a test attaches it, so the local input stands still.
//
// Each client is made as an app makes it, on a Clock and a Scheduler of the test's
// (`PageTimers.layer`, `arcadekit/net/testing`): the Clock reads the faked `performance.now()`
// (Effect's own reads `process.hrtime` in Node, which fake timers don't reach), and the
// Scheduler runs fibers on microtasks, as Foldkit's does in the browser, so no fiber waits on a
// real `setImmediate`.

type Event = CoopEvent.CoopEvent<TestGame.Event>;

/** What a test gives a client besides the game: its rooms, and what ticks and draws its run. */
type TestSeatOptions = Parameters<typeof testCoopClient>[1];
type Game<LoadError = never> = TestCoopParts<LoadError>;

let scope: Scope.Closeable;

/** Runs `effect` as the app does: in the app's scope, on the test's Clock and Scheduler. */
const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(effect.pipe(Scope.provide(scope), onPage));

/** Forks `effect` as `run` runs it. */
const fork = <A, E>(effect: Effect.Effect<A, E>): Fiber.Fiber<A, E> =>
  Effect.runFork(onPage(effect));

interface Player<LoadError = never> {
  readonly coop: TestCoopClient<LoadError>;
  readonly events: Event[];
}

const client = async <LoadError = never>(
  hub: FakeCoopRooms.FakeCoopRooms,
  game: Game<LoadError> = testCoopParts<LoadError>(),
  options: Partial<TestSeatOptions> = {}
): Promise<Player<LoadError>> => {
  const events: Event[] = [];
  const coop = await run(
    Effect.gen(function* () {
      const made = yield* testCoopClient(game, {
        rooms: hub.rooms,
        ...options,
      });
      yield* made.listen((event) => events.push(event));
      return made;
    })
  );
  return { coop, events };
};

const tags = (events: readonly Event[]) => events.map((event) => event._tag);

const started = (events: readonly Event[]) =>
  events.find((event) => event._tag === "RunStarted");

const failed = (events: readonly Event[]) =>
  events.find((event) => event._tag === "SeatFailed");

const lastLobby = (events: readonly Event[]) =>
  events.findLast((event) => event._tag === "LobbyChanged");

/** The run's own events a seat heard, without its samples. */
const heard = (events: readonly Event[]): TestGame.Event[] =>
  events.flatMap((event) =>
    event._tag === "RunEvent" && event.event._tag !== "Score"
      ? [event.event]
      : []
  );

/** The run's last sample a seat heard. */
const sampled = (events: readonly Event[]): TestGame.Score | undefined =>
  events
    .flatMap((event) =>
      event._tag === "RunEvent" && event.event._tag === "Score"
        ? [event.event]
        : []
    )
    .at(-1);

/**
 * Everything a seat reported from its run's start on, in order: `RunStarted`, then each of the
 * run's events and samples as the rules reported it.
 */
const fromStart = (events: readonly Event[]) =>
  events
    .slice(events.findIndex((event) => event._tag === "RunStarted"))
    .map((event) => (event._tag === "RunEvent" ? event.event : event));

/** Each time a seat said who its run waits on, with somebody to name. */
const named = (events: readonly Event[]) =>
  events.filter(
    (event) => event._tag === "WaitingChanged" && event.waitingFor.length > 0
  );

/** Lets queued microtasks run, at the current fake time. */
const settle = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

const game = (
  content: Partial<TestGame.Content> = {},
  options: TestCoopOptions = {}
): Game =>
  testCoopParts({
    content: Effect.succeed({ ...TestGame.content, ...content }),
    ...options,
  });

/** A host and a guest in one lobby, the host with pick `red` and the guest `green`. */
const lobbyOfTwo = async (
  hub: FakeCoopRooms.FakeCoopRooms,
  games: { readonly host?: Game; readonly guest?: Game } = {},
  options: Partial<TestSeatOptions> = {}
) => {
  const host = await client(hub, games.host, options);
  const guest = await client(hub, games.guest, options);
  await run(host.coop.host("red"));
  await settle();
  await run(guest.coop.join(hub.code, "green"));
  await settle();
  return { host, guest };
};

/** A ticker on the page's timer, as the default one is in Node, that says when it starts and stops. */
const loggedTicker =
  (log: (line: string) => void): Ticker.Ticker =>
  (onTick) => {
    log("made");
    const timer = setInterval(onTick, 4);
    return () => {
      clearInterval(timer);
      log("released");
    };
  };

const duo = () => testCoopParts({ maxPlayers: 2 });

/** One player's payload in a lockstep message, as a peer on other code would encode it. */
const NOT_AN_INPUT = "not an input";

/** A lockstep message of a run, as far as these tests read and forge one. */
interface ForgedMessage {
  readonly kind: string;
  /** The step of the first of `inputs` or `steps`. */
  readonly from?: number;
  /** A peer's own payloads, by step. */
  inputs?: unknown[];
  /** The host's confirmed steps: each a list of [player, payload] pairs, then the removed players. */
  steps?: [[string, unknown][], string[]][];
}

/** A lockstep message's text after `change` has had its way with the message. */
const forged =
  (change: ((message: ForgedMessage) => void) | undefined) =>
  (text: string): string => {
    const message = JSON.parse(text) as ForgedMessage;
    change?.(message);
    return JSON.stringify(message);
  };

/**
 * `rooms`, where a guest's lockstep channel passes what it sends through `sent`, and what it
 * hears through `heard`: the raw messages, forged as they cross.
 */
const forging = (
  rooms: CoopRooms.CoopRooms,
  forge: {
    readonly sent?: (message: ForgedMessage) => void;
    readonly heard?: (message: ForgedMessage) => void;
  }
): CoopRooms.CoopRooms => {
  const outgoing = forged(forge.sent);
  const incoming = forged(forge.heard);
  return CoopRooms.make({
    host: rooms.host,
    join: (code) =>
      rooms.join(code).pipe(
        Effect.map((room) =>
          SignallingRoom.make({
            ...room,
            links: () =>
              room.links().map((link) =>
                PeerLink.make({
                  ...link,
                  lockstep: {
                    ...link.lockstep,
                    send: (text) => link.lockstep.send(outgoing(text)),
                    listen: (handler) =>
                      link.lockstep.listen((text) => handler(incoming(text))),
                  },
                })
              ),
          })
        )
      ),
  });
};

/** A guest's room whose host says `said` on its link, then starts. */
const scriptedRoom = (
  said: readonly string[],
  closed: Effect.Effect<void> = Effect.never
): SignallingRoom.SignallingRoom => {
  const silent: PeerLink.TextChannel = {
    send: () => {},
    listen: () => () => {},
    onClose: () => () => {},
    isOpen: () => true,
  };
  const link: PeerLink.PeerLink = PeerLink.make({
    peer: "host",
    lockstep: silent,
    messages: {
      ...silent,
      listen: (handler) => {
        for (const text of said) {
          handler(text);
        }
        return () => {};
      },
    },
    closed,
  });
  return SignallingRoom.make({
    role: "guest",
    code: "K7MQ2X",
    self: "guest-1",
    host: "host",
    events: Stream.make(
      { type: "peer-connected", peer: "host", link },
      { type: "started" }
    ),
    links: () => [link],
    start: Effect.void,
  });
};

/**
 * Rooms with no one to link to, numbered as they open, whose release takes `releaseMs(room)`:
 * a socket and links that close slowly. No room has a join code.
 */
const numberedRooms = (
  log: string[],
  releaseMs: (room: number) => number
): CoopRooms.CoopRooms => {
  let opened = 0;
  return CoopRooms.make({
    host: Effect.suspend(() => {
      opened += 1;
      const room = opened;
      return Effect.acquireRelease(
        Effect.sync((): SignallingRoom.SignallingRoom => {
          log.push(`open ${room}`);
          return SignallingRoom.make({
            role: "host",
            code: `ROOM${room}`,
            self: "host",
            host: "host",
            events: Stream.never,
            links: () => [],
            start: Effect.void,
          });
        }),
        () =>
          Effect.sleep(Duration.millis(releaseMs(room))).pipe(
            Effect.andThen(Effect.sync(() => log.push(`release ${room}`)))
          )
      );
    }),
    join: () =>
      Effect.fail(
        new SignallingRoom.RoomError({
          reason: "unknown-code",
          message: "No room has that code.",
        })
      ),
  });
};

/** A client on `rooms` that logs each event beside the rooms' own lines. */
const loggedClient = async (rooms: CoopRooms.CoopRooms, log: string[]) => {
  const { coop } = await client(FakeCoopRooms.make(), testCoopParts(), {
    rooms,
  });
  await run(
    coop.listen((event) =>
      log.push(
        event._tag === "LobbyChanged" ? `lobby ${event.code}` : event._tag
      )
    )
  );
  return coop;
};

const fakeTimers = () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "performance"],
    });
    scope = Effect.runSync(Scope.make());
  });

  afterEach(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    vi.useRealTimers();
  });
};

describe("a co-op run", () => {
  fakeTimers();

  it("gathers a lobby, starts everyone with their picks and steps the same run", async () => {
    const hub = FakeCoopRooms.make();
    const { host, guest } = await lobbyOfTwo(hub);
    await run(guest.coop.choose("blue"));
    await settle();
    const lobby = {
      code: "K7MQ2X",
      players: [
        { id: "host", name: "Host", pick: "red" },
        { id: "guest-1", name: "Guest 1", pick: "blue" },
      ],
      maxPlayers: 4,
      canStart: true,
    };
    expect([lastLobby(host.events), lastLobby(guest.events)]).toStrictEqual([
      new CoopEvent.LobbyChanged({ ...lobby, role: "host", self: "host" }),
      new CoopEvent.LobbyChanged({ ...lobby, role: "guest", self: "guest-1" }),
    ]);

    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(5000);
    const [hostRun, guestRun] = [host.coop.debug(), guest.coop.debug()];
    expect([started(host.events), started(guest.events)]).toStrictEqual([
      new CoopEvent.RunStarted({ slot: 0, names: ["Host", "Guest 1"] }),
      new CoopEvent.RunStarted({ slot: 1, names: ["Host", "Guest 1"] }),
    ]);
    // Both stepped most of the 5 s, and agree on the state at every step both hashed.
    const common = Object.keys(hostRun.hashes).filter(
      (step) => step in guestRun.hashes
    );
    expect([
      hostRun.error,
      guestRun.error,
      hostRun.stepIndex > 200,
      common.length > 2,
      common.map((step) => hostRun.hashes[Number(step)]),
      [hostRun.slot, guestRun.slot],
      [hostRun.state?.picks, guestRun.state?.picks],
    ]).toStrictEqual([
      null,
      null,
      true,
      true,
      common.map((step) => guestRun.hashes[Number(step)]),
      [0, 1],
      [
        ["red", "blue"],
        ["red", "blue"],
      ],
    ]);
  });

  it("shows who it waits on, then stops with a clear error when the host goes quiet", async () => {
    const hub = FakeCoopRooms.make();
    const { host, guest } = await lobbyOfTwo(hub);
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(1000);
    await run(host.coop.leave);
    await vi.advanceTimersByTimeAsync(12_000);
    const waited = guest.events.some(
      (event) =>
        event._tag === "WaitingChanged" && event.waitingFor.includes("Host")
    );
    expect([waited, guest.events.at(-1)]).toStrictEqual([
      true,
      new CoopEvent.SeatFailed({
        reason: "hostLost",
        message: "Lost the host: nothing heard for 10 s. The run is over.",
      }),
    ]);
  });

  it("names who it waits on only once stepping has waited 300 ms", async () => {
    const hub = FakeCoopRooms.make();
    const stalled = ManualTicker.make();
    const host = await client(hub);
    const guest = await client(hub, testCoopParts(), {
      ticker: stalled.ticker,
    });
    await run(host.coop.host("red"));
    await settle();
    await run(guest.coop.join(hub.code, "green"));
    await settle();
    await run(host.coop.start);
    // The guest's ticker stands still, so the host's run waits on it from its first step.
    await vi.advanceTimersByTimeAsync(296);
    const early = named(host.events).length > 0;
    await vi.advanceTimersByTimeAsync(104);
    expect([
      early,
      host.events.findLast((event) => event._tag === "WaitingChanged"),
    ]).toStrictEqual([
      false,
      new CoopEvent.WaitingChanged({ waitingFor: ["Guest 1"] }),
    ]);
  });

  // A host whose clock is ahead of a guest's by more than the input delay always has a step due
  // that the guest's input hasn't reached, so its session says it waits on the guest at every
  // tick, while it steps at the pace the input arrives: at full rate. That is no wait to show.
  it("names nobody while the run steps, though a guest that began late keeps it a step behind", async () => {
    const hub = FakeCoopRooms.make();
    const late = ManualTicker.make();
    const host = await client(hub);
    const guest = await client(hub, testCoopParts(), { ticker: late.ticker });
    await run(host.coop.host("red"));
    await settle();
    await run(guest.coop.join(hub.code, "green"));
    await settle();
    await run(host.coop.start);
    // The guest's session begins at its first tick, 100 ms after the host's: more than the 67 ms
    // its input is scheduled ahead.
    await vi.advanceTimersByTimeAsync(100);
    const from = host.coop.debug().stepIndex;
    for (let i = 0; i < 750; i++) {
      ManualTicker.tick(late);
      // oxlint-disable-next-line no-await-in-loop -- each tick's messages cross before the next.
      await vi.advanceTimersByTimeAsync(4);
    }
    expect([
      // Three seconds at 60 steps a second, on both.
      host.coop.debug().stepIndex - from > 170,
      guest.coop.debug().stepIndex > 170,
      named(host.events),
      named(guest.events),
    ]).toStrictEqual([true, true, [], []]);
  });

  it("keeps the last 32 state hashes for debug", async () => {
    const hub = FakeCoopRooms.make();
    const often = testCoopParts({ lockstep: { hashEvery: 2 } });
    const { host, guest } = await lobbyOfTwo(hub, {
      host: often,
      guest: often,
    });
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(5000);
    const steps = Object.keys(host.coop.debug().hashes).map(Number);
    expect([
      steps.length,
      Object.keys(guest.coop.debug().hashes).length,
      // One hash every 2 steps: the 32 kept are the last 32 taken.
      Math.max(...steps) - Math.min(...steps),
      host.coop.debug().stepIndex - Math.max(...steps) < 2,
    ]).toStrictEqual([32, 32, 62, true]);
  });

  it("reports a seat in order: its lobby, one start, the run, then its failure last", async () => {
    const hub = FakeCoopRooms.make();
    const { host, guest } = await lobbyOfTwo(hub);
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(1000);
    FakeCoopRooms.closeHost(hub);
    await vi.advanceTimersByTimeAsync(15_000);
    const order = tags(guest.events).join(" ");
    expect([
      /^(?:LobbyChanged )+RunStarted (?:(?:RunEvent|WaitingChanged) )+SeatFailed$/u.test(
        order
      ),
      tags(guest.events).filter((tag) => tag === "RunStarted").length,
      tags(guest.events).filter((tag) => tag === "SeatFailed").length,
    ]).toStrictEqual([true, 1, 1]);
  });

  // A run's first news is what `create` reports: here an offer for each player, in a game it
  // may be the first stage's banner. A guest's run starts in a tick, on the host's start message.
  // A host's starts as its session is made, before the seat can listen to it, and the session
  // tells that start at its first tick: to the seat, which has said `RunStarted` by then.
  it("tells the host's seat what the run's start reports as it tells a guest's: after RunStarted, in one order, each once", async () => {
    const hub = FakeCoopRooms.make();
    const opening = game({ offerAtStart: true });
    const { host, guest } = await lobbyOfTwo(hub, {
      host: opening,
      guest: opening,
    });
    await run(host.coop.start);
    // Half of the 100 ms a second sample is due after: the start's sample is the only one.
    await vi.advanceTimersByTimeAsync(50);
    const names = ["Host", "Guest 1"];
    const start = [
      new TestGame.OfferOpened({ offer: 1, slot: 0 }),
      new TestGame.OfferOpened({ offer: 1, slot: 1 }),
      new TestGame.Score({ steps: 0, totals: [0, 0], owes: [true, true] }),
    ];
    expect([fromStart(host.events), fromStart(guest.events)]).toStrictEqual([
      [new CoopEvent.RunStarted({ slot: 0, names }), ...start],
      [new CoopEvent.RunStarted({ slot: 1, names }), ...start],
    ]);
    // Nothing of the start comes again: a second later each seat has heard each offer once.
    await vi.advanceTimersByTimeAsync(1000);
    expect([heard(host.events), heard(guest.events)]).toStrictEqual([
      start.slice(0, 2),
      start.slice(0, 2),
    ]);
  });

  it("closes the room and the ticker before it reports a run that stopped", async () => {
    const hub = FakeCoopRooms.make();
    const ticker = loggedTicker((line) => {
      if (line === "released") {
        hub.log.push("release ticker");
      }
    });
    const { host, guest } = await lobbyOfTwo(hub, {}, { ticker });
    await run(
      guest.coop.listen((event) => {
        if (event._tag === "SeatFailed") {
          hub.log.push("failed");
        }
      })
    );
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(1000);
    await run(host.coop.leave);
    const left = hub.log.length;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(hub.log.slice(left)).toStrictEqual([
      "release ticker",
      "release guest-1",
      "failed",
    ]);
  });

  it("keeps the run's end when the others leave a run that has ended", async () => {
    const hub = FakeCoopRooms.make();
    const short = game({ length: 60 });
    const { host, guest } = await lobbyOfTwo(hub, {
      host: short,
      guest: short,
    });
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(3000);
    const end = new TestGame.RunEnded({ totals: [0, 0] });
    expect([heard(host.events), heard(guest.events)]).toStrictEqual([
      [end],
      [end],
    ]);
    await run(host.coop.leave);
    await vi.advanceTimersByTimeAsync(12_000);
    // The guest's session lost the host, but the run had ended: no failure, no waiting banner,
    // and its room closed as it stopped.
    const afterEnd = guest.events.slice(
      guest.events.findIndex(
        (event) => event._tag === "RunEvent" && event.event._tag === "RunEnded"
      )
    );
    expect([
      guest.coop.debug().error,
      heard(afterEnd),
      tags(afterEnd).filter((tag) => tag !== "RunEvent"),
      hub.log.filter((line) => line.endsWith("guest-1")),
    ]).toStrictEqual([
      "Lost the host host: nothing heard for 10000 ms",
      [end],
      [],
      ["open guest-1", "release guest-1"],
    ]);
  });
});

describe("hosting, joining and leaving", () => {
  fakeTimers();

  it("opens no room when the player leaves while the content still loads", async () => {
    const hub = FakeCoopRooms.make();
    const loaded = Effect.runSync(
      Deferred.make<TestGame.Content, { readonly message: string }>()
    );
    const { coop, events } = await client(
      hub,
      testCoopParts({ content: Deferred.await(loaded) })
    );
    await run(coop.host("red"));
    await settle();
    await run(coop.leave);
    Effect.runSync(Deferred.succeed(loaded, TestGame.content));
    await settle();
    expect([hub.log, events]).toStrictEqual([[], []]);
  });

  it("closes the room it hosted as it hosts the next, whose lobby alone is reported", async () => {
    const hub = FakeCoopRooms.make();
    const { coop, events } = await client(hub);
    await run(coop.listen((event) => hub.log.push(event._tag)));
    await run(coop.host("red"));
    await settle();
    const first = [...hub.log];
    await run(coop.host("green"));
    const atSwap = hub.log.slice(first.length);
    await settle();
    // The next room opens first, then the one before it closes, before `host` returns. The
    // seat before says nothing more, and the next speaks only once it has closed.
    expect([first, atSwap, hub.log.slice(first.length)]).toStrictEqual([
      ["open host", "LobbyChanged"],
      ["open host", "release host", "LobbyChanged"],
      ["open host", "release host", "LobbyChanged"],
    ]);
    expect([tags(events), lastLobby(events)]).toMatchObject([
      ["LobbyChanged", "LobbyChanged"],
      { players: [{ id: "host", name: "Host", pick: "green" }] },
    ]);
  });

  it("lets a new seat speak only once every seat before it has closed", async () => {
    const log: string[] = [];
    // The first room is slow to close; the others close fast.
    const coop = await loggedClient(
      numberedRooms(log, (room) => (room === 1 ? 200 : 10)),
      log
    );
    await run(coop.host("red"));
    await settle();
    // The second seat is replaced while it waits for the first to close.
    await run(coop.host("green"));
    await run(coop.host("blue"));
    await vi.advanceTimersByTimeAsync(100);
    const early = [...log];
    await vi.advanceTimersByTimeAsync(200);
    const leaving = run(coop.leave);
    await vi.advanceTimersByTimeAsync(100);
    await leaving;
    expect([early, log.slice(early.length)]).toStrictEqual([
      ["open 1", "lobby ROOM1", "open 2", "open 3", "release 2"],
      ["release 1", "lobby ROOM3", "release 3"],
    ]);
  });

  it("reports a new seat's failure only once the seat before it has closed", async () => {
    const log: string[] = [];
    const coop = await loggedClient(
      numberedRooms(log, () => 50),
      log
    );
    await run(coop.host("red"));
    await settle();
    // No room has that code: the new seat fails at once.
    await run(coop.join("NOPE42", "green"));
    await settle();
    const early = [...log];
    await vi.advanceTimersByTimeAsync(100);
    expect([early, log.slice(early.length)]).toStrictEqual([
      ["open 1", "lobby ROOM1"],
      ["release 1", "SeatFailed"],
    ]);
  });

  it("returns from leave only once every seat still closing has closed", async () => {
    const log: string[] = [];
    const coop = await loggedClient(
      numberedRooms(log, (room) => (room === 1 ? 200 : 10)),
      log
    );
    await run(coop.host("red"));
    await settle();
    await run(coop.host("green"));
    // The first seat is still closing, and the second waits for it.
    const leaving = run(coop.leave).then(() => log.push("left"));
    await vi.advanceTimersByTimeAsync(300);
    await leaving;
    expect(log).toStrictEqual([
      "open 1",
      "lobby ROOM1",
      "open 2",
      "release 2",
      "release 1",
      "left",
    ]);
  });

  it("has no seat once its scope has closed", async () => {
    const hub = FakeCoopRooms.make();
    const own = Effect.runSync(Scope.make());
    const coop = await Effect.runPromise(
      testCoopClient(testCoopParts(), { rooms: hub.rooms }).pipe(
        Scope.provide(own),
        onPage
      )
    );
    await run(coop.host("red"));
    await settle();
    const seated = coop.debug().slot;
    await Effect.runPromise(Scope.close(own, Exit.void));
    expect([seated, coop.debug().slot, hub.log]).toStrictEqual([
      0,
      -1,
      ["open host", "release host"],
    ]);
  });

  it("closes the room, the session and the ticker when the player leaves the run", async () => {
    const hub = FakeCoopRooms.make();
    const tickers: string[] = [];
    const ticker = loggedTicker((line) => tickers.push(line));
    const { host, guest } = await lobbyOfTwo(hub, {}, { ticker });
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(1000);
    const stepping = guest.coop.debug().stepIndex > 30;
    await run(guest.coop.leave);
    const afterLeave = guest.coop.debug();
    const quiet = guest.events.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect([
      stepping,
      hub.log.filter((line) => line.endsWith("guest-1")),
      tickers,
      afterLeave,
      guest.events.length - quiet,
    ]).toStrictEqual([
      true,
      ["open guest-1", "release guest-1"],
      ["made", "made", "released"],
      { stepIndex: 0, error: null, hashes: {}, slot: -1, state: null },
      0,
    ]);
  });

  it("stops the default ticker with the run", async () => {
    const hub = FakeCoopRooms.make();
    const { host, guest } = await lobbyOfTwo(hub);
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(1000);
    const ticking = vi.getTimerCount();
    await run(guest.coop.leave);
    await run(host.coop.leave);
    expect([ticking >= 2, vi.getTimerCount()]).toStrictEqual([true, 0]);
  });

  it("reports a room that can't be opened, and content that can't be loaded", async () => {
    const unreachable = new SignallingRoom.RoomError({
      reason: "unreachable",
      message: "Couldn't reach the signalling server at ws://unused.",
    });
    const hub = FakeCoopRooms.make();
    const offline = await client(hub, testCoopParts(), {
      rooms: { ...hub.rooms, host: Effect.fail(unreachable) },
    });
    const broken = await client(
      hub,
      testCoopParts({ content: Effect.fail({ message: "heroes.json: 404" }) })
    );
    await run(offline.coop.host("red"));
    await run(broken.coop.join(hub.code, "red"));
    await settle();
    expect([offline.events, broken.events, hub.log]).toStrictEqual([
      [
        new CoopEvent.SeatFailed({
          reason: "room",
          message: unreachable.message,
        }),
      ],
      [
        new CoopEvent.SeatFailed({
          reason: "content",
          message: "heroes.json: 404",
        }),
      ],
      [],
    ]);
  });

  it("reports a bug in a seat as its failure, and logs it", async () => {
    const hub = FakeCoopRooms.make();
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const { coop, events } = await client(
      hub,
      testCoopParts({ content: Effect.die(new Error("no heroes")) })
    );
    await run(coop.host("red"));
    await settle();
    expect([events, logged.mock.calls.length > 0]).toStrictEqual([
      [
        new CoopEvent.SeatFailed({
          reason: "bug",
          message: "Co-op stopped on a bug: no heroes",
        }),
      ],
      true,
    ]);
    logged.mockRestore();
  });

  it("reports a bug in its room as its failure, and logs it", async () => {
    const hub = FakeCoopRooms.make();
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const buggy: SignallingRoom.SignallingRoom = SignallingRoom.make({
      role: "host",
      code: "K7MQ2X",
      self: "host",
      host: "host",
      events: Stream.die(new Error("room bug")),
      links: () => [],
      start: Effect.void,
    });
    const { coop, events } = await client(hub, testCoopParts(), {
      rooms: { ...hub.rooms, host: Effect.succeed(buggy) },
    });
    await run(coop.host("red"));
    await settle();
    expect([
      tags(events),
      events.at(-1),
      logged.mock.calls.length > 0,
    ]).toStrictEqual([
      ["LobbyChanged", "SeatFailed"],
      new CoopEvent.SeatFailed({
        reason: "bug",
        message: "Co-op stopped on a bug: room bug",
      }),
      true,
    ]);
    logged.mockRestore();
  });

  it("refuses to start a lobby of one, or a guest's start", async () => {
    const hub = FakeCoopRooms.make();
    const host = await client(hub);
    await run(host.coop.host("red"));
    await settle();
    await run(host.coop.start);
    await settle();
    const alone = [started(host.events), lastLobby(host.events)];
    const guest = await client(hub);
    await run(guest.coop.join(hub.code, "green"));
    await settle();
    await run(guest.coop.start);
    await vi.advanceTimersByTimeAsync(1000);
    expect([alone, started(host.events), started(guest.events)]).toMatchObject([
      [undefined, { canStart: false }],
      undefined,
      undefined,
    ]);
  });

  it("refuses a start above the game's number of players, until one leaves the lobby", async () => {
    const hub = FakeCoopRooms.make();
    const { host, guest } = await lobbyOfTwo(hub, {
      host: duo(),
      guest: duo(),
    });
    const third = await client(hub, duo());
    await run(third.coop.join(hub.code, "blue"));
    await settle();
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(500);
    const full = [lastLobby(host.events), started(host.events)];
    FakeCoopRooms.drop(hub, "guest-2");
    await settle();
    const two = lastLobby(guest.events);
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(500);
    expect([full, two, started(host.events)]).toMatchObject([
      [{ maxPlayers: 2, canStart: false, players: [{}, {}, {}] }, undefined],
      {
        maxPlayers: 2,
        canStart: true,
        players: [{ id: "host" }, { id: "guest-1" }],
      },
      { _tag: "RunStarted", names: ["Host", "Guest 1"] },
    ]);
  });

  it("starts no more players than the game takes when a guest links as the host starts", async () => {
    const hub = FakeCoopRooms.make();
    const { host, guest } = await lobbyOfTwo(hub, {
      host: duo(),
      guest: duo(),
    });
    const third = await client(hub, duo());
    // The host asks to start a lobby of two, and a third player links before the worker's word.
    const starting = run(host.coop.start);
    const joining = run(third.coop.join(hub.code, "blue"));
    await starting;
    await joining;
    await vi.advanceTimersByTimeAsync(1000);
    const hostRun = host.coop.debug();
    expect([
      lastLobby(host.events),
      started(host.events),
      started(guest.events),
      hostRun.state?.picks,
      [hostRun.error, hostRun.stepIndex > 30],
      third.events.at(-1),
    ]).toMatchObject([
      // The third was in the lobby at the start: one too many.
      { canStart: false, players: [{}, {}, { id: "guest-2" }] },
      new CoopEvent.RunStarted({ slot: 0, names: ["Host", "Guest 1"] }),
      new CoopEvent.RunStarted({ slot: 1, names: ["Host", "Guest 1"] }),
      ["red", "green"],
      [null, true],
      new CoopEvent.SeatFailed({
        reason: "leftOut",
        message: "The run started without you.",
      }),
    ]);
  });

  it("can't start while a player has no pick, and takes a pick made while the room opens", async () => {
    const hub = FakeCoopRooms.make();
    const host = await client(hub);
    const guest = await client(hub);
    await run(host.coop.host(""));
    await run(host.coop.choose("red"));
    await settle();
    await run(guest.coop.join(hub.code, ""));
    await settle();
    const before = lastLobby(host.events);
    await run(guest.coop.choose("green"));
    await settle();
    expect([before, lastLobby(host.events)]).toMatchObject([
      {
        canStart: false,
        players: [
          { id: "host", pick: "red" },
          { id: "guest-1", pick: "" },
        ],
      },
      { canStart: true, players: [{ pick: "red" }, { pick: "green" }] },
    ]);
  });
});

describe("lobby picks at the start", () => {
  fakeTimers();

  it("replaces a pick the host's game doesn't have with its first", async () => {
    const hub = FakeCoopRooms.make();
    const host = await client(hub);
    const guest = await client(hub);
    await run(host.coop.host("purple"));
    await settle();
    await run(guest.coop.join(hub.code, "green"));
    await settle();
    const shown = lastLobby(guest.events);
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(500);
    expect([
      shown,
      host.coop.debug().state?.picks,
      guest.coop.debug().state?.picks,
    ]).toMatchObject([
      { players: [{ pick: "purple" }, { pick: "green" }] },
      ["red", "green"],
      ["red", "green"],
    ]);
  });

  it("fails a guest whose game doesn't have a pick the host started with", async () => {
    const hub = FakeCoopRooms.make();
    const { host, guest } = await lobbyOfTwo(hub, {
      guest: game({ picks: ["green"] }),
    });
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(500);
    expect([
      started(host.events) !== undefined,
      tags(guest.events).includes("RunStarted"),
      guest.events.at(-1),
      hub.log.filter((line) => line.endsWith("guest-1")),
    ]).toStrictEqual([
      true,
      false,
      new CoopEvent.SeatFailed({
        reason: "unknownPick",
        message:
          "The host started with a pick your game doesn't have. Are you both on the same version?",
      }),
      ["open guest-1", "release guest-1"],
    ]);
  });
});

/** Sends `command` as `player` does, without waiting: how it ended, once the timers have run. */
const send = <LoadError>(
  player: Player<LoadError>,
  command: TestGame.AnswerOffer | TestGame.HoldPause
) => run(Effect.result(player.coop.send(command)));

describe("sending a command", () => {
  fakeTimers();

  it("has every peer's rules take it once, at one step, and tells its sender alone", async () => {
    const hub = FakeCoopRooms.make();
    const { host, guest } = await lobbyOfTwo(hub, {
      host: game({ offerEvery: 30 }),
      guest: game({ offerEvery: 30 }),
    });
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(1500);
    // Offer 1 is open for both: the run waits on it.
    const frozen = host.coop.debug().state?.steps;
    const offered = [heard(host.events), heard(guest.events)];
    const bothOffered = [
      new TestGame.OfferOpened({ offer: 1, slot: 0 }),
      new TestGame.OfferOpened({ offer: 1, slot: 1 }),
    ];
    const owing = sampled(host.events)?.owes;
    const taken = send(host, new TestGame.AnswerOffer({ offer: 1, value: 5 }));
    await vi.advanceTimersByTimeAsync(500);
    const states = [host, guest].map(({ coop }) => {
      // A copy: the state is the run's own, and goes on changing.
      const state = structuredClone(coop.debug().state);
      return [state?.bonus, state?.owes, state?.steps];
    });
    const guestSees = sampled(guest.events)?.owes;
    const guestTaken = send(
      guest,
      new TestGame.AnswerOffer({ offer: 1, value: 7 })
    );
    await vi.advanceTimersByTimeAsync(300);
    const after = guest.coop.debug().state;
    expect([
      frozen,
      offered,
      owing,
      await taken,
      states,
      guestSees,
      await guestTaken,
      [after?.bonus, (after?.steps ?? 0) > 30],
      sampled(host.events)?.owes,
      // Stepping never waited on a player: a run that waits on a decision still steps.
      tags(host.events).includes("WaitingChanged"),
    ]).toStrictEqual([
      30,
      // Each seat hears the run's events as every peer's rules reported them: both offers.
      [bothOffered, bothOffered],
      // Who the run waits on to decide is the game's to say: its sample does, on every seat.
      [true, true],
      Result.succeed(undefined),
      // Applied once on both: a command rides one step.
      [
        [[5, 0], [false, true], 30],
        [[5, 0], [false, true], 30],
      ],
      [false, true],
      Result.succeed(undefined),
      [[5, 7], true],
      [false, false],
      false,
    ]);
  });

  it("completes after its seat's listener heard what the command's step reported", async () => {
    const hub = FakeCoopRooms.make();
    // The run starts on an offer and opens the next after every step, so the answer that
    // closes one opens another in the same step: what an app looks for after a pick.
    const chained = { offerAtStart: true, offerEvery: 1 };
    const { host, guest } = await lobbyOfTwo(hub, {
      host: game(chained),
      guest: game(chained),
    });
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(500);
    // What each seat heard of offers from here on, and where its own send completed.
    const order: Record<"host" | "guest", string[]> = { host: [], guest: [] };
    const answer = async (name: "host" | "guest", { coop }: Player) => {
      await run(
        coop.listen((event) => {
          if (event._tag === "RunEvent" && event.event._tag === "OfferOpened") {
            const { offer, slot } = event.event;
            order[name].push(`heard: offer ${offer} for ${slot}`);
          }
        })
      );
      const sent = run(
        coop
          .send(new TestGame.AnswerOffer({ offer: 1, value: 1 }))
          .pipe(Effect.andThen(Effect.sync(() => order[name].push("answered"))))
      );
      await vi.advanceTimersByTimeAsync(300);
      await sent;
    };
    // The host's answer closes nothing: the guest still owes, so its step reports nothing.
    await answer("host", host);
    // The guest's closes offer 1, and that step opens offer 2 for both.
    await answer("guest", guest);
    expect(order).toStrictEqual({
      host: ["answered", "heard: offer 2 for 0", "heard: offer 2 for 1"],
      guest: ["heard: offer 2 for 0", "heard: offer 2 for 1", "answered"],
    });
  });

  it("fails with the rejection the rules refused it with, having changed nothing on any peer", async () => {
    const hub = FakeCoopRooms.make();
    const { host, guest } = await lobbyOfTwo(hub, {
      host: game({ offerEvery: 30 }),
      guest: game({ offerEvery: 30 }),
    });
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(1500);
    // No offer 9 is open.
    const stale = send(host, new TestGame.AnswerOffer({ offer: 9, value: 1 }));
    await vi.advanceTimersByTimeAsync(300);
    const first = send(host, new TestGame.AnswerOffer({ offer: 1, value: 2 }));
    const second = send(host, new TestGame.AnswerOffer({ offer: 1, value: 3 }));
    await vi.advanceTimersByTimeAsync(300);
    expect([
      await stale,
      await first,
      // The host owed offer 1 nothing more by the time its second answer came.
      await second,
      host.coop.debug().state?.bonus,
      guest.coop.debug().state?.bonus,
      [host.coop.debug().error, guest.coop.debug().error],
    ]).toStrictEqual([
      Result.fail(new TestGame.NothingOwed({ offer: 9 })),
      Result.succeed(undefined),
      Result.fail(new TestGame.NothingOwed({ offer: 1 })),
      [2, 0],
      [2, 0],
      [null, null],
    ]);
  });

  it("holds the run for everyone while a player holds the pause, and lets it go", async () => {
    const hub = FakeCoopRooms.make();
    const { host, guest } = await lobbyOfTwo(hub);
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(1000);
    const running = host.coop.debug().state?.steps ?? 0;
    const held = send(guest, new TestGame.HoldPause({ held: true }));
    await vi.advanceTimersByTimeAsync(500);
    const paused = host.coop.debug().state?.steps ?? 0;
    await vi.advanceTimersByTimeAsync(500);
    const stillPaused = host.coop.debug().state?.steps ?? 0;
    const released = send(guest, new TestGame.HoldPause({ held: false }));
    await vi.advanceTimersByTimeAsync(500);
    expect([
      running > 30,
      await held,
      paused === stillPaused,
      await released,
      (host.coop.debug().state?.steps ?? 0) > paused,
    ]).toStrictEqual([
      true,
      Result.succeed(undefined),
      true,
      Result.succeed(undefined),
      true,
    ]);
  });

  it("fails with CommandDropped while there is no run: with no seat, and in the lobby", async () => {
    const hub = FakeCoopRooms.make();
    const alone = await client(hub);
    const noSeat = await send(alone, new TestGame.HoldPause({ held: true }));
    const { host } = await lobbyOfTwo(hub);
    const inLobby = await send(
      host,
      new TestGame.AnswerOffer({ offer: 0, value: 1 })
    );
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(1000);
    expect([
      noSeat,
      inLobby,
      // Neither reached a run that started later.
      host.coop.debug().state?.bonus,
      (host.coop.debug().state?.steps ?? 0) > 30,
    ]).toStrictEqual([
      Result.fail(
        new CommandDropped({ command: "HoldPause", reason: "noRun" })
      ),
      Result.fail(
        new CommandDropped({ command: "AnswerOffer", reason: "noRun" })
      ),
      [0, 0],
      true,
    ]);
  });

  it("fails with CommandDropped when the player leaves before the rules answer", async () => {
    const hub = FakeCoopRooms.make();
    const { host, guest } = await lobbyOfTwo(hub);
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(1000);
    // Sent and left in one go: no tick comes between to give the command a step.
    const leaving = send(guest, new TestGame.HoldPause({ held: true }));
    await run(guest.coop.leave);
    const afterLeaving = await send(
      guest,
      new TestGame.HoldPause({ held: true })
    );
    await vi.advanceTimersByTimeAsync(500);
    expect([
      await leaving,
      afterLeaving,
      // The others' run never got it.
      host.coop.debug().state?.held,
    ]).toStrictEqual([
      Result.fail(
        new CommandDropped({ command: "HoldPause", reason: "runEnded" })
      ),
      // No seat any more: there is no run to ask.
      Result.fail(
        new CommandDropped({ command: "HoldPause", reason: "noRun" })
      ),
      [false, false],
    ]);
  });

  it("fails with CommandDropped when the run stops before the rules answer, and at once after", async () => {
    const hub = FakeCoopRooms.make();
    const { host, guest } = await lobbyOfTwo(hub);
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(1000);
    await run(host.coop.leave);
    await vi.advanceTimersByTimeAsync(500);
    // The guest's run waits on a host that is gone: its command waits with it.
    const waiting = send(guest, new TestGame.HoldPause({ held: true }));
    await vi.advanceTimersByTimeAsync(11_000);
    const runEnded = new CommandDropped({
      command: "HoldPause",
      reason: "runEnded",
    });
    expect([
      guest.events.at(-1)?._tag,
      await waiting,
      // The seat is still this player's, with its run stopped: the same answer, at once.
      await send(guest, new TestGame.HoldPause({ held: false })),
    ]).toStrictEqual([
      "SeatFailed",
      Result.fail(runEnded),
      Result.fail(runEnded),
    ]);
  });
});

describe("why a seat failed", () => {
  fakeTimers();

  it("fails a guest whose link to the host closes after the start, before the host's start message", async () => {
    const hub = FakeCoopRooms.make();
    // The host dropped this guest at the start: its room started, then its link closed.
    const hostLeft = Effect.runSync(Deferred.make<undefined>());
    const dropped = scriptedRoom([], Deferred.await(hostLeft));
    const { coop, events } = await client(hub, testCoopParts(), {
      rooms: { ...hub.rooms, join: () => Effect.succeed(dropped) },
    });
    await run(coop.join("K7MQ2X", "green"));
    await settle();
    const beforeClose = tags(events);
    Effect.runSync(Deferred.succeed(hostLeft, undefined));
    await settle();
    expect([beforeClose, events.at(-1)]).toStrictEqual([
      ["LobbyChanged"],
      new CoopEvent.SeatFailed({
        reason: "hostLost",
        message: "Lost the host before the run started.",
      }),
    ]);
  });

  it("fails a guest the host started without", async () => {
    const hub = FakeCoopRooms.make();
    const leftOut = scriptedRoom([
      encodeLobbyMessage({
        type: "start",
        players: ["host", "guest-2"],
        picks: ["red", "green"],
      }),
    ]);
    const { coop, events } = await client(hub, testCoopParts(), {
      rooms: { ...hub.rooms, join: () => Effect.succeed(leftOut) },
    });
    await run(coop.join("K7MQ2X", "green"));
    await settle();
    expect(events.at(-1)).toStrictEqual(
      new CoopEvent.SeatFailed({
        reason: "leftOut",
        message: "The run started without you.",
      })
    );
  });

  it("fails a guest the host started with more players than its game takes", async () => {
    const hub = FakeCoopRooms.make();
    // A host on another build, whose game takes three.
    const tooMany = scriptedRoom([
      encodeLobbyMessage({
        type: "start",
        players: ["host", "guest-1", "guest-2"],
        picks: ["red", "green", "blue"],
      }),
    ]);
    const { coop, events } = await client(hub, duo(), {
      rooms: { ...hub.rooms, join: () => Effect.succeed(tooMany) },
    });
    await run(coop.join("K7MQ2X", "green"));
    await settle();
    expect([tags(events), events.at(-1)]).toStrictEqual([
      ["LobbyChanged", "SeatFailed"],
      new CoopEvent.SeatFailed({
        reason: "tooManyPlayers",
        message:
          "The host started with more players than your game takes. Are you both on the same version?",
      }),
    ]);
  });

  it("fails a guest whose room fails in the lobby", async () => {
    const hub = FakeCoopRooms.make();
    const { guest } = await lobbyOfTwo(hub);
    FakeCoopRooms.closeHost(hub);
    await settle();
    expect(guest.events.at(-1)).toStrictEqual(
      new CoopEvent.SeatFailed({
        reason: "room",
        message: "The host left.",
      })
    );
  });

  it("stops everyone on a desync", async () => {
    const hub = FakeCoopRooms.make();
    const lockstep = { hashEvery: 10 };
    const { host, guest } = await lobbyOfTwo(hub, {
      host: testCoopParts({ lockstep }),
      guest: {
        ...testCoopParts({ lockstep }),
        hash: (state) => TestGame.hash(state) + 1,
      },
    });
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(3000);
    expect([failed(host.events), failed(guest.events)]).toMatchObject([
      { reason: "desync" },
      { reason: "desync" },
    ]);
    expect(guest.events.at(-1)).toMatchObject({
      message: expect.stringMatching(
        /^The run stopped: the players' games no longer match\. Desync after step 10: /u
      ) as unknown,
    });
  });

  it("fails a guest whose content differs from the host's", async () => {
    const hub = FakeCoopRooms.make();
    const { host, guest } = await lobbyOfTwo(hub, {
      guest: game({ length: 5 }),
    });
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(1000);
    expect(guest.events.at(-1)).toMatchObject({
      _tag: "SeatFailed",
      reason: "contentMismatch",
      message: expect.stringMatching(
        /^Your game content differs from the host's, so you can't play this run together \(host [0-9a-f]{8}, yours [0-9a-f]{8}\)\.$/u
      ) as unknown,
    });
  });

  it("fails a guest the host removed for stalling the run", async () => {
    const hub = FakeCoopRooms.make();
    const stalled = ManualTicker.make();
    const host = await client(hub);
    const guest = await client(hub, testCoopParts(), {
      ticker: stalled.ticker,
    });
    await run(host.coop.host("red"));
    await settle();
    await run(guest.coop.join(hub.code, "green"));
    await settle();
    await run(host.coop.start);
    // The guest's ticker stands still: the host waits on it, then removes it and plays on.
    await vi.advanceTimersByTimeAsync(12_000);
    const alone = host.coop.debug();
    for (let i = 0; i < 20; i++) {
      ManualTicker.tick(stalled);
      // oxlint-disable-next-line no-await-in-loop -- each tick's messages cross before the next.
      await vi.advanceTimersByTimeAsync(20);
    }
    expect([
      alone.error,
      alone.stepIndex > 30,
      ManualTicker.ticking(stalled),
      guest.events.at(-1),
    ]).toMatchObject([
      null,
      true,
      0,
      {
        _tag: "SeatFailed",
        reason: "removed",
        message: expect.stringMatching(
          /^The host removed you from the run at step \d+: it waited on you too long\.$/u
        ) as unknown,
      },
    ]);
    // The host said who it waited on, then that the wait was over: it names nobody once it
    // steps again, so an app's "Waiting for Guest 1…" goes.
    expect(
      host.events.filter((event) => event._tag === "WaitingChanged")
    ).toStrictEqual([
      new CoopEvent.WaitingChanged({ waitingFor: ["Guest 1"] }),
      new CoopEvent.WaitingChanged({ waitingFor: [] }),
    ]);
  });

  it("fails a guest whose input the host can't read, and one that can't read the host's", async () => {
    // Every input the guest sends is forged on its way to the host.
    const hubA = FakeCoopRooms.make();
    const garbled = await lobbyOfTwo(
      hubA,
      {},
      {
        rooms: forging(hubA.rooms, {
          sent: (message) => {
            message.inputs?.fill(NOT_AN_INPUT);
          },
        }),
      }
    );
    await run(garbled.host.coop.start);
    await vi.advanceTimersByTimeAsync(1000);
    // Every input in the steps the host confirms is forged on its way to the guest.
    const hubB = FakeCoopRooms.make();
    const deaf = await lobbyOfTwo(
      hubB,
      {},
      {
        rooms: forging(hubB.rooms, {
          heard: (message) => {
            for (const [inputs] of message.steps ?? []) {
              for (const input of inputs) {
                input[1] = NOT_AN_INPUT;
              }
            }
          },
        }),
      }
    );
    await run(deaf.host.coop.start);
    await vi.advanceTimersByTimeAsync(1000);
    expect([
      garbled.guest.events.at(-1),
      deaf.guest.events.at(-1),
    ]).toMatchObject([
      {
        _tag: "SeatFailed",
        reason: "removed",
        message: expect.stringMatching(
          /your game sent input it couldn't read\. Are you both on the same version\?$/u
        ) as unknown,
      },
      {
        _tag: "SeatFailed",
        reason: "badInput",
        message: expect.stringMatching(
          /^The run stopped: input from \S+ for step \d+ couldn't be read\. Are you both on the same version\?$/u
        ) as unknown,
      },
    ]);
  });
});

describe("drawing a co-op run", () => {
  fakeTimers();

  const element = {} as HTMLElement;

  it("draws from the guest's own slot once the run starts, with the one view it made, and reads its input", async () => {
    const frames = ManualFrames.make();
    const hub = FakeCoopRooms.make();
    const made: string[] = [];
    const drawn: [number, readonly string[], number | undefined][] = [];
    const guestGame = testCoopParts({
      presentation: Effect.sync(() => {
        made.push("presentation");
        return testPresentation({
          input: () => {
            made.push("input");
            return {
              read: () => ({ add: 2 }),
              dispose: () => made.push("dispose input"),
            };
          },
          view: (_container, { local }) => {
            made.push("view");
            return {
              render: (state) =>
                drawn.push([local.slot, local.names, state?.totals.length]),
              dispose: () => made.push("dispose view"),
            };
          },
        });
      }),
    });
    const { host, guest } = await lobbyOfTwo(
      hub,
      { guest: guestGame },
      { frames }
    );
    const attach = fork(guest.coop.attach(element));
    await settle();
    ManualFrames.runFrameAt(frames, 100);
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(500);
    ManualFrames.runFrameAt(frames, 600);
    await Effect.runPromise(Fiber.interrupt(attach));
    const totals = host.coop.debug().state?.totals ?? [];
    await vi.advanceTimersByTimeAsync(500);
    expect([
      made,
      drawn,
      // Only the guest was attached: its input moved its total, at 2 a step.
      [totals[0], (totals[1] ?? 0) > 0, (totals[1] ?? 0) % 2],
      // Detaching doesn't leave: the run goes on, the guest standing still.
      guest.coop.debug().error,
      guest.coop.debug().stepIndex > 40,
    ]).toStrictEqual([
      ["presentation", "view", "input", "dispose input", "dispose view"],
      [
        [0, [], undefined],
        [1, ["Host", "Guest 1"], 2],
      ],
      [0, true, 0],
      null,
      true,
    ]);
  });

  it("sends null for its player while nothing is attached, and what its devices hold once something is", async () => {
    const frames = ManualFrames.make();
    const hub = FakeCoopRooms.make();
    /** Each payload the guest sent, by step, as it was on the wire. */
    const sent = new Map<number, string>();
    const rooms = forging(hub.rooms, {
      sent: (message) => {
        for (const [i, payload] of (message.inputs ?? []).entries()) {
          sent.set((message.from ?? 0) + i, JSON.stringify(payload));
        }
      },
    });
    const { host, guest } = await lobbyOfTwo(hub, {}, { frames, rooms });
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(500);
    const detached = new Set(sent.values());
    const attach = fork(guest.coop.attach(element));
    await settle();
    await vi.advanceTimersByTimeAsync(500);
    const attached = [...sent.values()].at(-1);
    await Effect.runPromise(Fiber.interrupt(attach));
    await vi.advanceTimersByTimeAsync(500);
    const totals = host.coop.debug().state?.totals ?? [];
    expect([
      detached,
      attached,
      [...sent.values()].at(-1),
      // The rules saw a player with no input, then one that adds 1 a step, then none again.
      [totals[0], (totals[1] ?? 0) > 20],
      [host.coop.debug().error, guest.coop.debug().error],
    ]).toStrictEqual([
      new Set(["[null]"]),
      '[{"add":1}]',
      "[null]",
      [0, true],
      [null, null],
    ]);
  });

  it("leaves when a frame crashes, with nothing left attached", async () => {
    const frames = ManualFrames.make();
    const hub = FakeCoopRooms.make();
    const bug = new Error("lost context");
    const guestGame = testCoopParts({
      presentation: Effect.succeed(
        testPresentation({
          view: () => ({
            render: (state: TestGame.State | null) => {
              if (state !== null) {
                throw bug;
              }
            },
            dispose: () => {},
          }),
        })
      ),
    });
    const { host, guest } = await lobbyOfTwo(
      hub,
      { guest: guestGame },
      { frames }
    );
    const attach = fork(guest.coop.attach(element));
    await settle();
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(500);
    ManualFrames.runFrameAt(frames, 600);
    const exit = await Effect.runPromise(Fiber.await(attach));
    expect([
      ManualFrames.waiting(frames),
      guest.coop.debug().slot,
      hub.log.filter((line) => line.endsWith("guest-1")),
    ]).toStrictEqual([false, -1, ["open guest-1", "release guest-1"]]);
    expect(failures(exit)).toStrictEqual([
      new GameCrashed({ message: "lost context", cause: bug }),
    ]);
    // A tagged error's `message` and `cause` aren't enumerable, so the comparison above holds
    // the error's class and neither of them.
    const crash = Option.getOrUndefined(Exit.findErrorOption(exit));
    expect(crash).toMatchObject({
      _tag: "GameCrashed",
      message: "lost context",
    });
    expect(crash?.cause).toBe(bug);
  });

  it("leaves when the presentation can't load, or the view can't be made", async () => {
    const hub = FakeCoopRooms.make();
    const noSheet = { _tag: "NoSheet" } as const;
    const unloaded = await client(
      hub,
      testCoopParts({ presentation: Effect.fail(noSheet) })
    );
    await run(unloaded.coop.host("red"));
    await settle();
    const loadError = await run(Effect.flip(unloaded.coop.attach(element)));
    const afterLoad = [...hub.log];
    const noWebGl = new Error("no WebGL");
    const blind = await client(
      hub,
      testCoopParts({
        presentation: Effect.succeed(
          testPresentation({
            view: () => {
              throw noWebGl;
            },
          })
        ),
      })
    );
    await run(blind.coop.host("red"));
    await settle();
    const attachError = await run(Effect.flip(blind.coop.attach(element)));
    expect([
      loadError,
      afterLoad,
      attachError,
      hub.log.slice(afterLoad.length),
      blind.coop.debug().slot,
    ]).toStrictEqual([
      noSheet,
      ["open host", "release host"],
      new AttachError({ message: "no WebGL", cause: noWebGl }),
      ["open host", "release host"],
      -1,
    ]);
    // A tagged error's `message` and `cause` aren't enumerable, so the comparison above holds
    // the error's class and neither of them.
    expect(attachError).toMatchObject({
      _tag: "AttachError",
      message: "no WebGL",
    });
    expect(attachError.cause).toBe(noWebGl);
  });
});
