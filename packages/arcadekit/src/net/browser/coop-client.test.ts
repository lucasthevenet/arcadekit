import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Result,
  Scheduler,
  Scope,
  Stream,
} from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AttachError, GameCrashed } from "../../runtime/browser";
import { manualFrames } from "../../runtime/testing";
import { encodeLobbyMessage } from "../lobby";
import type { Ticker } from "../scoped";
import {
  fakeCoopRooms,
  hashTestState,
  manualTicker,
  testContent,
  testCoopGame,
  testPresentation,
} from "../testing/index";
import type {
  FakeCoopRooms,
  TestAnswer,
  TestContent,
  TestCoop,
  TestCoopGameOptions,
  TestLocalEvent,
  TestState,
} from "../testing/index";
import type { PeerLink, TextChannel } from "./channel";
import type {
  CoopClient,
  CoopClientOptions,
  CoopEvent,
  CoopGame,
} from "./coop";
import { makeCoopClient } from "./coop-client";
import { RoomError } from "./errors";
import type { SignallingRoom } from "./signalling";

// The Co-op client in Node, with no browser, playing the test game (`arcadekit/net/testing`): a
// fake signalling hub links the host to each guest with in-memory channels, and fake timers
// drive the clients' tickers. Nothing is attached unless a test attaches it, so the local input
// stands still.
//
// Each client is made as an app makes it, on a Clock and a Scheduler of the test's: the Clock
// reads the faked `performance.now()` (Effect's own reads `process.hrtime` in Node, which fake
// timers don't reach), and the Scheduler runs fibers on microtasks, as Foldkit's does in the
// browser, so no fiber waits on a real `setImmediate`.

type Event = CoopEvent<TestLocalEvent>;
type Game<LoadError = never> = CoopGame<TestCoop, LoadError>;

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

/** Runs `effect` as the app does: in the app's scope, on the test's Clock and Scheduler. */
const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Scope.provide(scope),
      Effect.provideService(Clock.Clock, performanceClock),
      Effect.provideService(Scheduler.Scheduler, microtasks)
    )
  );

/** Forks `effect` as `run` runs it. */
const fork = <A, E>(effect: Effect.Effect<A, E>): Fiber.Fiber<A, E> =>
  Effect.runFork(
    effect.pipe(
      Effect.provideService(Clock.Clock, performanceClock),
      Effect.provideService(Scheduler.Scheduler, microtasks)
    )
  );

interface Player<LoadError = never> {
  readonly coop: CoopClient<TestCoop, LoadError>;
  readonly events: Event[];
}

const client = async <LoadError = never>(
  hub: FakeCoopRooms,
  game: Game<LoadError> = testCoopGame<LoadError>(),
  options: Partial<CoopClientOptions> = {}
): Promise<Player<LoadError>> => {
  const events: Event[] = [];
  const coop = await run(
    Effect.gen(function* () {
      const made = yield* makeCoopClient(game, {
        rooms: hub.rooms,
        ...options,
      });
      yield* made.listen((event) => events.push(event));
      return made;
    })
  );
  return { coop, events };
};

const types = (events: readonly Event[]) => events.map((event) => event.type);

const started = (events: readonly Event[]) =>
  events.find((event) => event.type === "started");

const failed = (events: readonly Event[]) =>
  events.find((event) => event.type === "failed");

const lastLobby = (events: readonly Event[]) =>
  events.findLast((event) => event.type === "lobby");

/** What the local player heard of the run, without its samples. */
const heard = (events: readonly Event[]): TestLocalEvent[] =>
  events.flatMap((event) =>
    event.type === "run" && event.event.type !== "score" ? [event.event] : []
  );

/** Lets queued microtasks run, at the current fake time. */
const settle = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

const game = (
  content: Partial<TestContent> = {},
  options: TestCoopGameOptions = {}
): Game =>
  testCoopGame({
    content: Effect.succeed({ ...testContent, ...content }),
    ...options,
  });

/** A host and a guest in one lobby, the host with pick `red` and the guest `green`. */
const lobbyOfTwo = async (
  hub: FakeCoopRooms,
  games: { readonly host?: Game; readonly guest?: Game } = {},
  options: Partial<CoopClientOptions> = {}
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
  (log: (line: string) => void): Ticker =>
  (onTick) => {
    log("made");
    const timer = setInterval(onTick, 4);
    return () => {
      clearInterval(timer);
      log("released");
    };
  };

const duo = () => testCoopGame({ maxPlayers: 2 });

/** A game that records the answer each scheduled step's input was filled with. */
const watched = (content: Partial<TestContent>) => {
  const sent: (TestAnswer | null)[] = [];
  const base = game(content);
  const watching: Game = {
    ...base,
    localInput: () => {
      const fill = base.localInput();
      return (device, answer, paused) => {
        sent.push(answer);
        return fill(device, answer, paused);
      };
    },
  };
  return { game: watching, sent };
};

/** A guest's room whose host says `said` on its link, then starts. */
const scriptedRoom = (
  said: readonly string[],
  closed: Effect.Effect<void> = Effect.never
): SignallingRoom => {
  const silent: TextChannel = {
    send: () => {},
    listen: () => () => {},
    onClose: () => () => {},
    isOpen: () => true,
  };
  const link: PeerLink = {
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
  };
  return {
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
  };
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
    const hub = fakeCoopRooms();
    const { host, guest } = await lobbyOfTwo(hub);
    await run(guest.coop.choose("blue"));
    await settle();
    const lobby = {
      type: "lobby",
      code: "K7MQ2X",
      players: [
        { id: "host", name: "Host", pick: "red" },
        { id: "guest-1", name: "Guest 1", pick: "blue" },
      ],
      maxPlayers: 4,
      canStart: true,
    };
    expect([lastLobby(host.events), lastLobby(guest.events)]).toStrictEqual([
      { ...lobby, role: "host", self: "host" },
      { ...lobby, role: "guest", self: "guest-1" },
    ]);

    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(5000);
    const [hostRun, guestRun] = [host.coop.debug(), guest.coop.debug()];
    expect([started(host.events), started(guest.events)]).toStrictEqual([
      { type: "started", slot: 0, names: ["Host", "Guest 1"] },
      { type: "started", slot: 1, names: ["Host", "Guest 1"] },
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
    const hub = fakeCoopRooms();
    const { host, guest } = await lobbyOfTwo(hub);
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(1000);
    await run(host.coop.leave);
    await vi.advanceTimersByTimeAsync(12_000);
    const waited = guest.events.some(
      (event) => event.type === "waiting" && event.waitingFor.includes("Host")
    );
    expect([waited, guest.events.at(-1)]).toStrictEqual([
      true,
      {
        type: "failed",
        reason: "hostLost",
        message: "Lost the host: nothing heard for 10 s. The run is over.",
      },
    ]);
  });

  it("reports a seat in order: its lobby, one start, the run, then its failure last", async () => {
    const hub = fakeCoopRooms();
    const { host, guest } = await lobbyOfTwo(hub);
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(1000);
    hub.closeHost();
    await vi.advanceTimersByTimeAsync(15_000);
    const order = types(guest.events).join(" ");
    expect([
      /^(?:lobby )+started (?:(?:run|waiting) )+failed$/u.test(order),
      types(guest.events).filter((type) => type === "started").length,
      types(guest.events).filter((type) => type === "failed").length,
    ]).toStrictEqual([true, 1, 1]);
  });

  it("closes the room and the ticker before it reports a run that stopped", async () => {
    const hub = fakeCoopRooms();
    const ticker = loggedTicker((line) => {
      if (line === "released") {
        hub.log.push("release ticker");
      }
    });
    const { host, guest } = await lobbyOfTwo(hub, {}, { ticker });
    await run(
      guest.coop.listen((event) => {
        if (event.type === "failed") {
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
    const hub = fakeCoopRooms();
    const short = game({ length: 60 });
    const { host, guest } = await lobbyOfTwo(hub, {
      host: short,
      guest: short,
    });
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(3000);
    const end = {
      type: "ended",
      total: 0,
      names: ["Host", "Guest 1"],
    };
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
        (event) => event.type === "run" && event.event.type === "ended"
      )
    );
    expect([
      guest.coop.debug().error,
      afterEnd.filter(
        (event) => !(event.type === "run" && event.event.type === "score")
      ),
      hub.log.filter((line) => line.endsWith("guest-1")),
    ]).toStrictEqual([
      "Lost the host host: nothing heard for 10000 ms",
      [{ type: "run", event: end }],
      ["open guest-1", "release guest-1"],
    ]);
  });
});

describe("hosting, joining and leaving", () => {
  fakeTimers();

  it("opens no room when the player leaves while the content still loads", async () => {
    const hub = fakeCoopRooms();
    const loaded = Effect.runSync(
      Deferred.make<TestContent, { readonly message: string }>()
    );
    const { coop, events } = await client(
      hub,
      testCoopGame({ content: Deferred.await(loaded) })
    );
    await run(coop.host("red"));
    await settle();
    await run(coop.leave);
    Effect.runSync(Deferred.succeed(loaded, testContent));
    await settle();
    expect([hub.log, events]).toStrictEqual([[], []]);
  });

  it("closes the room it hosted as it hosts the next, whose lobby alone is reported", async () => {
    const hub = fakeCoopRooms();
    const { coop, events } = await client(hub);
    await run(coop.listen((event) => hub.log.push(event.type)));
    await run(coop.host("red"));
    await settle();
    const first = [...hub.log];
    await run(coop.host("green"));
    const atSwap = hub.log.slice(first.length);
    await settle();
    // The next room opens first, then the one before it closes, before `host` returns. The
    // seat before says nothing more, and the next speaks only once it has closed.
    expect([first, atSwap, hub.log.slice(first.length)]).toStrictEqual([
      ["open host", "lobby"],
      ["open host", "release host", "lobby"],
      ["open host", "release host", "lobby"],
    ]);
    expect([types(events), lastLobby(events)]).toMatchObject([
      ["lobby", "lobby"],
      { players: [{ id: "host", name: "Host", pick: "green" }] },
    ]);
  });

  it("closes the room, the session and the ticker when the player leaves the run", async () => {
    const hub = fakeCoopRooms();
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
    const hub = fakeCoopRooms();
    const { host, guest } = await lobbyOfTwo(hub);
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(1000);
    const ticking = vi.getTimerCount();
    await run(guest.coop.leave);
    await run(host.coop.leave);
    expect([ticking >= 2, vi.getTimerCount()]).toStrictEqual([true, 0]);
  });

  it("reports a room that can't be opened, and content that can't be loaded", async () => {
    const unreachable = new RoomError({
      reason: "unreachable",
      message: "Couldn't reach the signalling server at ws://unused.",
    });
    const hub = fakeCoopRooms();
    const offline = await client(hub, testCoopGame(), {
      rooms: { ...hub.rooms, host: Effect.fail(unreachable) },
    });
    const broken = await client(
      hub,
      testCoopGame({ content: Effect.fail({ message: "heroes.json: 404" }) })
    );
    await run(offline.coop.host("red"));
    await run(broken.coop.join(hub.code, "red"));
    await settle();
    expect([offline.events, broken.events, hub.log]).toStrictEqual([
      [{ type: "failed", reason: "room", message: unreachable.message }],
      [{ type: "failed", reason: "content", message: "heroes.json: 404" }],
      [],
    ]);
  });

  it("reports a bug in a seat as its failure, and logs it", async () => {
    const hub = fakeCoopRooms();
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const { coop, events } = await client(
      hub,
      testCoopGame({ content: Effect.die(new Error("no heroes")) })
    );
    await run(coop.host("red"));
    await settle();
    expect([events, logged.mock.calls.length > 0]).toStrictEqual([
      [
        {
          type: "failed",
          reason: "bug",
          message: "Co-op stopped on a bug: no heroes",
        },
      ],
      true,
    ]);
    logged.mockRestore();
  });

  it("reports a bug in its room as its failure, and logs it", async () => {
    const hub = fakeCoopRooms();
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const buggy: SignallingRoom = {
      role: "host",
      code: "K7MQ2X",
      self: "host",
      host: "host",
      events: Stream.die(new Error("room bug")),
      links: () => [],
      start: Effect.void,
    };
    const { coop, events } = await client(hub, testCoopGame(), {
      rooms: { ...hub.rooms, host: Effect.succeed(buggy) },
    });
    await run(coop.host("red"));
    await settle();
    expect([
      types(events),
      events.at(-1),
      logged.mock.calls.length > 0,
    ]).toStrictEqual([
      ["lobby", "failed"],
      {
        type: "failed",
        reason: "bug",
        message: "Co-op stopped on a bug: room bug",
      },
      true,
    ]);
    logged.mockRestore();
  });

  it("refuses to start a lobby of one, or a guest's start", async () => {
    const hub = fakeCoopRooms();
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
    const hub = fakeCoopRooms();
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
    hub.drop("guest-2");
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
      { type: "started", names: ["Host", "Guest 1"] },
    ]);
  });

  it("can't start while a player has no pick, and takes a pick made while the room opens", async () => {
    const hub = fakeCoopRooms();
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
    const hub = fakeCoopRooms();
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
    const hub = fakeCoopRooms();
    const { host, guest } = await lobbyOfTwo(hub, {
      guest: game({ picks: ["green"] }),
    });
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(500);
    expect([
      started(host.events) !== undefined,
      types(guest.events).includes("started"),
      guest.events.at(-1),
      hub.log.filter((line) => line.endsWith("guest-1")),
    ]).toStrictEqual([
      true,
      false,
      {
        type: "failed",
        reason: "unknownPick",
        message:
          "The host started with a pick your game doesn't have. Are you both on the same version?",
      },
      ["open guest-1", "release guest-1"],
    ]);
  });
});

describe("answers and pause", () => {
  fakeTimers();

  it("holds an answer on the input until it settles, and says who else is choosing", async () => {
    const hub = fakeCoopRooms();
    const { game: hostGame, sent } = watched({ offerEvery: 30 });
    const { host, guest } = await lobbyOfTwo(hub, {
      host: hostGame,
      guest: game({ offerEvery: 30 }),
    });
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(1500);
    // Offer 1 is open for both: the run waits on it.
    const frozen = host.coop.debug().state?.steps;
    const offered = [heard(host.events), heard(guest.events)];
    const choosing = host.events.findLast((event) => event.type === "waiting");
    await run(host.coop.answer({ offer: 1, value: 5 }));
    await vi.advanceTimersByTimeAsync(500);
    const answered = sent.filter((answer) => answer !== null);
    const hostState = structuredClone(host.coop.debug().state);
    const guestSees = guest.events.findLast(
      (event) => event.type === "waiting"
    );
    await run(guest.coop.answer({ offer: 1, value: 7 }));
    await vi.advanceTimersByTimeAsync(300);
    const after = guest.coop.debug().state;
    expect([
      frozen,
      offered,
      choosing,
      // Sent with several steps' input, then dropped: the last steps went without it.
      answered.length > 1,
      answered.every((answer) => answer.offer === 1 && answer.value === 5),
      sent.at(-1),
      [hostState?.bonus, hostState?.owes, hostState?.steps],
      guestSees,
      [after?.bonus, (after?.steps ?? 0) > 30],
      host.events.findLast((event) => event.type === "waiting"),
    ]).toStrictEqual([
      30,
      [[{ type: "offer", offer: 1 }], [{ type: "offer", offer: 1 }]],
      { type: "waiting", waitingFor: [], choosing: ["Guest 1"] },
      true,
      true,
      null,
      [[5, 0], [false, true], 30],
      { type: "waiting", waitingFor: [], choosing: [] },
      [[5, 7], true],
      { type: "waiting", waitingFor: [], choosing: [] },
    ]);
  });

  it("drops an answer that is already settled, and replaces a held answer with a new one", async () => {
    const hub = fakeCoopRooms();
    const { game: hostGame, sent } = watched({ offerEvery: 30 });
    const { host } = await lobbyOfTwo(hub, {
      host: hostGame,
      guest: game({ offerEvery: 30 }),
    });
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(1500);
    // No offer 9 is open: its answer never reaches a step's input.
    await run(host.coop.answer({ offer: 9, value: 1 }));
    await vi.advanceTimersByTimeAsync(200);
    const stale = sent.filter((answer) => answer !== null);
    await run(host.coop.answer({ offer: 1, value: 2 }));
    await run(host.coop.answer({ offer: 1, value: 3 }));
    await vi.advanceTimersByTimeAsync(200);
    expect([
      stale,
      sent.some((answer) => answer?.value === 2),
      host.coop.debug().state?.bonus,
    ]).toStrictEqual([[], false, [3, 0]]);
  });

  it("takes no answer or pause before the run, and holds the run while a player pauses", async () => {
    const hub = fakeCoopRooms();
    const { game: hostGame, sent } = watched({});
    const { host, guest } = await lobbyOfTwo(hub, { host: hostGame });
    await run(host.coop.setPaused(true));
    await run(host.coop.answer({ offer: 0, value: 1 }));
    await run(host.coop.start);
    // Once the run has started, a lobby pick changes nothing.
    await vi.advanceTimersByTimeAsync(1000);
    await run(guest.coop.choose("blue"));
    const running = host.coop.debug().state?.steps ?? 0;
    await run(guest.coop.setPaused(true));
    await vi.advanceTimersByTimeAsync(500);
    const held = host.coop.debug().state?.steps ?? 0;
    await vi.advanceTimersByTimeAsync(500);
    const stillHeld = host.coop.debug().state?.steps ?? 0;
    await run(guest.coop.setPaused(false));
    await vi.advanceTimersByTimeAsync(500);
    expect([
      running > 30,
      sent.every((answer) => answer === null),
      held === stillHeld,
      (host.coop.debug().state?.steps ?? 0) > held,
      host.coop.debug().state?.picks,
    ]).toStrictEqual([true, true, true, true, ["red", "green"]]);
  });
});

describe("why a seat failed", () => {
  fakeTimers();

  it("fails a guest whose link to the host closes after the start, before the host's start message", async () => {
    const hub = fakeCoopRooms();
    // The host dropped this guest at the start: its room started, then its link closed.
    const hostLeft = Effect.runSync(Deferred.make<undefined>());
    const dropped = scriptedRoom([], Deferred.await(hostLeft));
    const { coop, events } = await client(hub, testCoopGame(), {
      rooms: { ...hub.rooms, join: () => Effect.succeed(dropped) },
    });
    await run(coop.join("K7MQ2X", "green"));
    await settle();
    const beforeClose = types(events);
    Effect.runSync(Deferred.succeed(hostLeft, undefined));
    await settle();
    expect([beforeClose, events.at(-1)]).toStrictEqual([
      ["lobby"],
      {
        type: "failed",
        reason: "hostLost",
        message: "Lost the host before the run started.",
      },
    ]);
  });

  it("fails a guest the host started without", async () => {
    const hub = fakeCoopRooms();
    const leftOut = scriptedRoom([
      encodeLobbyMessage({
        type: "start",
        players: ["host", "guest-2"],
        picks: ["red", "green"],
      }),
    ]);
    const { coop, events } = await client(hub, testCoopGame(), {
      rooms: { ...hub.rooms, join: () => Effect.succeed(leftOut) },
    });
    await run(coop.join("K7MQ2X", "green"));
    await settle();
    expect(events.at(-1)).toStrictEqual({
      type: "failed",
      reason: "leftOut",
      message: "The run started without you.",
    });
  });

  it("fails a guest whose room fails in the lobby", async () => {
    const hub = fakeCoopRooms();
    const { guest } = await lobbyOfTwo(hub);
    hub.closeHost();
    await settle();
    expect(guest.events.at(-1)).toStrictEqual({
      type: "failed",
      reason: "room",
      message: "The host left.",
    });
  });

  it("stops everyone on a desync", async () => {
    const hub = fakeCoopRooms();
    const lockstep = { hashEvery: 10 };
    const { host, guest } = await lobbyOfTwo(hub, {
      host: testCoopGame({ lockstep }),
      guest: {
        ...testCoopGame({ lockstep }),
        hash: (state) => hashTestState(state) + 1,
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
    const hub = fakeCoopRooms();
    const { host, guest } = await lobbyOfTwo(hub, {
      guest: game({ length: 5 }),
    });
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(1000);
    expect(guest.events.at(-1)).toMatchObject({
      type: "failed",
      reason: "contentMismatch",
      message: expect.stringMatching(
        /^Your game content differs from the host's, so you can't play this run together \(host [0-9a-f]{8}, yours [0-9a-f]{8}\)\.$/u
      ) as unknown,
    });
  });

  it("fails a guest the host removed for stalling the run", async () => {
    const hub = fakeCoopRooms();
    const stalled = manualTicker();
    const host = await client(hub);
    const guest = await client(hub, testCoopGame(), {
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
      stalled.tick();
      // oxlint-disable-next-line no-await-in-loop -- each tick's messages cross before the next.
      await vi.advanceTimersByTimeAsync(20);
    }
    expect([
      alone.error,
      alone.stepIndex > 30,
      stalled.ticking(),
      guest.events.at(-1),
    ]).toMatchObject([
      null,
      true,
      0,
      {
        type: "failed",
        reason: "removed",
        message: expect.stringMatching(
          /^The host removed you from the run at step \d+: it waited on you too long\.$/u
        ) as unknown,
      },
    ]);
  });

  it("fails a guest whose input the host can't read, and one that can't read the host's", async () => {
    const base = testCoopGame();
    const hubA = fakeCoopRooms();
    const garbled = await lobbyOfTwo(hubA, {
      guest: {
        ...base,
        codec: { ...base.codec, encode: () => "not an input" },
      },
    });
    await run(garbled.host.coop.start);
    await vi.advanceTimersByTimeAsync(1000);
    const hubB = fakeCoopRooms();
    const deaf = await lobbyOfTwo(hubB, {
      guest: {
        ...base,
        codec: { ...base.codec, decode: () => Result.fail("not an input") },
      },
    });
    await run(deaf.host.coop.start);
    await vi.advanceTimersByTimeAsync(1000);
    expect([
      garbled.guest.events.at(-1),
      deaf.guest.events.at(-1),
    ]).toMatchObject([
      {
        type: "failed",
        reason: "removed",
        message: expect.stringMatching(
          /your game sent input it couldn't read\. Are you both on the same version\?$/u
        ) as unknown,
      },
      {
        type: "failed",
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
    const frames = manualFrames();
    const hub = fakeCoopRooms();
    const made: string[] = [];
    const drawn: [number, readonly string[], number | undefined][] = [];
    const guestGame = testCoopGame({
      presentation: Effect.sync(() => {
        made.push("presentation");
        return testPresentation({
          createInput: () => {
            made.push("input");
            return {
              read: () => ({ add: 2 }),
              dispose: () => made.push("dispose input"),
            };
          },
          createView: (_container, local) => {
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
    frames.runFrameAt(100);
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(500);
    frames.runFrameAt(600);
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
      ["presentation", "input", "view", "dispose view", "dispose input"],
      [
        [0, [], undefined],
        [1, ["Host", "Guest 1"], 2],
      ],
      [0, true, 0],
      null,
      true,
    ]);
  });

  it("leaves when a frame crashes, with nothing left attached", async () => {
    const frames = manualFrames();
    const hub = fakeCoopRooms();
    const guestGame = testCoopGame({
      presentation: Effect.succeed(
        testPresentation({
          createView: () => ({
            render: (state: TestState | null) => {
              if (state !== null) {
                throw new Error("lost context");
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
    frames.runFrameAt(600);
    const exit = await Effect.runPromise(Fiber.await(attach));
    expect([
      frames.waiting(),
      guest.coop.debug().slot,
      hub.log.filter((line) => line.endsWith("guest-1")),
    ]).toStrictEqual([false, -1, ["open guest-1", "release guest-1"]]);
    expect(exit).toMatchObject(
      Exit.fail(
        new GameCrashed({
          message: "lost context",
          cause: new Error("lost context"),
        })
      )
    );
  });

  it("leaves when the presentation can't load, or the view can't be made", async () => {
    const hub = fakeCoopRooms();
    const noSheet = { _tag: "NoSheet" } as const;
    const unloaded = await client(
      hub,
      testCoopGame({ presentation: Effect.fail(noSheet) })
    );
    await run(unloaded.coop.host("red"));
    await settle();
    const loadError = await run(Effect.flip(unloaded.coop.attach(element)));
    const afterLoad = [...hub.log];
    const noWebGl = new Error("no WebGL");
    const blind = await client(
      hub,
      testCoopGame({
        presentation: Effect.succeed(
          testPresentation({
            createView: () => {
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
  });
});
