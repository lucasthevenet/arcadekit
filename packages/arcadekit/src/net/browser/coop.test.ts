import {
  Clock,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Result,
  Scheduler,
  Schema,
  Scope,
} from "effect";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";

import * as Game from "../../game/browser";
import { manualFrames } from "../../runtime/testing";
import type { Ticker } from "../scoped";
import { microtasks, performanceClock } from "../test-harness";
import {
  AnswerOffer,
  HoldPause,
  NothingOwed,
  OfferOpened,
  RunEnded,
  Score,
  TestGame,
  fakeCoopRooms,
  hashTestState,
  manualTicker,
  testContent,
} from "../testing/index";
import type { FakeCoopRooms, TestEvent } from "../testing/index";
import { Coop, CoopTicker } from "./coop";
import * as Seat from "./coop-events";
import type { CoopRooms } from "./coop-rooms";

// A `Coop` declared the way a genre declares one, over an engine for the test game
// (`arcadekit/net/testing`), and played through its layer: fake rooms link a host and a guest,
// fake timers tick their runs, and a test runs the frames. What the Co-op client does with a
// game's parts has its own tests, on plain parts (coop-client.test.ts).

/** What the views and the input sources log to: the test's own service, to show the layer hands it over. */
class Log extends Context.Service<Log, string[]>()("test/Log") {}

/** The test game's content, as an app's content service gives it. */
class Levels extends Context.Service<Levels, { readonly length: number }>()(
  "test/Levels"
) {}

class TestEngine extends Game.Engine("TestEngine", {
  simulation: TestGame,
  uses: { log: Log },
  view: (_container, { log }, { local }) => ({
    render: (state) => {
      log.push(
        `seat ${local.slot} of [${local.names.join(", ")}] draws ${state === null ? "no run" : "a run"}`
      );
    },
    dispose: () => log.push("dispose view"),
  }),
  // One player's run fills slot 0 alone: a Coop doesn't make this source.
  input: () => ({
    read: () => ({ players: [{ add: 1 }], leaving: [] }),
    dispose: () => {},
  }),
}) {}

/** The content each seat loads: the test game's, as long as the app's levels say. */
const levels = Levels.pipe(
  Effect.map(({ length }) => ({ ...testContent, length }))
);

class TestCoop extends Coop("TestCoop", {
  engine: TestEngine,
  input: (_surface, { log }) => {
    log.push("input");
    return {
      read: () => ({ add: 2 }),
      dispose: () => log.push("dispose input"),
    };
  },
  content: levels,
  picks: (content) => content.picks,
  config: (content, picks) => ({ content, picks }),
  maxPlayers: 2,
  hash: hashTestState,
  ends: [RunEnded],
}) {}

type Event = Seat.CoopEvent<TestEvent>;

const element = {} as HTMLElement;

/** A ticker on the page's timer, which the tests fake. */
const pageTicker: Ticker = (onTick) => {
  const timer = setInterval(onTick, 4);
  return () => clearInterval(timer);
};

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

/** Lets queued microtasks run, at the current fake time. */
const settle = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

/** One player's Co-op client, from the declaration's layer over the app's services. */
const seat = async (hub: FakeCoopRooms, length = 1_000_000) => {
  const frames = manualFrames();
  const log: string[] = [];
  const events: Event[] = [];
  const coop = await run(
    Effect.gen(function* () {
      const context = yield* Layer.build(
        TestCoop.layer.pipe(
          Layer.provide(hub.layer),
          Layer.provide(Layer.succeed(CoopTicker, Effect.succeed(pageTicker))),
          Layer.provide(Layer.succeed(Game.Frames, frames)),
          Layer.provide(Layer.succeed(Log, log)),
          Layer.provide(Layer.succeed(Levels, { length }))
        )
      );
      const made = Context.get(context, TestCoop);
      yield* made.listen((event) => events.push(event));
      return made;
    })
  );
  return { coop, events, frames, log };
};

/** A host and a guest in one lobby, with their picks. */
const lobbyOfTwo = async (hub: FakeCoopRooms, length?: number) => {
  const host = await seat(hub, length);
  const guest = await seat(hub, length);
  await run(host.coop.host("red"));
  await settle();
  await run(guest.coop.join(hub.code, "green"));
  await settle();
  return { host, guest };
};

/** The run's own events a seat heard, without its samples. */
const reported = (events: readonly Event[]): TestEvent[] =>
  events.flatMap((event) =>
    event._tag === "RunEvent" && event.event._tag !== "Score"
      ? [event.event]
      : []
  );

describe("a declared Coop", () => {
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

  it("is the key of a Co-op client, named for the declaration, and keeps its engine", () => {
    expect([
      TestCoop.kind,
      TestCoop.coopName,
      TestCoop.key,
      TestCoop.engine === TestEngine,
    ]).toStrictEqual(["Coop", "TestCoop", "arcadekit/net/Coop/TestCoop", true]);
  });

  it("plays its engine's simulation from a lobby, and hears the run's own events", async () => {
    const hub = fakeCoopRooms();
    const { host, guest } = await lobbyOfTwo(hub, 60);
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(3000);
    const [hostRun, guestRun] = [host.coop.debug(), guest.coop.debug()];
    const common = Object.keys(hostRun.hashes).filter(
      (step) => step in guestRun.hashes
    );
    expect([
      host.events.find((event) => event._tag === "RunStarted"),
      guest.events.find((event) => event._tag === "RunStarted"),
      [hostRun.error, guestRun.error],
      hostRun.state?.picks,
      common.length > 0,
      common.map((step) => hostRun.hashes[Number(step)]),
      // The simulation's events, as it reported them: its sample, and the end of the run.
      guest.events.some(
        (event) => event._tag === "RunEvent" && event.event instanceof Score
      ),
      reported(host.events),
      reported(guest.events),
      // Each comes with the local player of the seat that heard it.
      [host, guest].map(({ events }) => {
        const heard = events.findLast((event) => event._tag === "RunEvent");
        return heard && [heard.local.slot, heard.local.names];
      }),
    ]).toStrictEqual([
      new Seat.RunStarted({ slot: 0, names: ["Host", "Guest 1"] }),
      new Seat.RunStarted({ slot: 1, names: ["Host", "Guest 1"] }),
      [null, null],
      ["red", "green"],
      true,
      common.map((step) => guestRun.hashes[Number(step)]),
      true,
      [new RunEnded({ totals: [0, 0] })],
      [new RunEnded({ totals: [0, 0] })],
      [
        [0, ["Host", "Guest 1"]],
        [1, ["Host", "Guest 1"]],
      ],
    ]);
  });

  it("ticks a run on a worker's timer unless a test provides its own, as it draws on Game.Frames", async () => {
    const hub = fakeCoopRooms();
    const ticks = manualTicker();
    const manual = () =>
      run(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            TestCoop.layer.pipe(
              Layer.provide(hub.layer),
              Layer.provide(ticks.layer),
              Layer.provide(Layer.succeed(Log, [])),
              Layer.provide(Layer.succeed(Levels, { length: 1_000_000 }))
            )
          );
          return Context.get(context, TestCoop);
        })
      );
    const [host, guest] = [await manual(), await manual()];
    await run(host.host("red"));
    await settle();
    await run(guest.join(hub.code, "green"));
    await settle();
    await run(host.start);
    await vi.advanceTimersByTimeAsync(1000);
    // No timer ticks these runs: they step when the test's ticker says so.
    const untouched = [ticks.ticking(), host.debug().stepIndex];
    for (let i = 0; i < 50; i++) {
      ticks.tick();
      // oxlint-disable-next-line no-await-in-loop -- each tick's messages cross before the next.
      await vi.advanceTimersByTimeAsync(20);
    }
    expect([untouched, host.debug().stepIndex > 10]).toStrictEqual([
      [2, 0],
      true,
    ]);
  });

  it("makes the engine's view for the seat the lobby gave, and its own input source for one player", async () => {
    const hub = fakeCoopRooms();
    const { host, guest } = await lobbyOfTwo(hub);
    const attach = Effect.runFork(
      guest.coop
        .attach(element)
        .pipe(
          Effect.provideService(Clock.Clock, performanceClock),
          Effect.provideService(Scheduler.Scheduler, microtasks)
        )
    );
    await settle();
    guest.frames.runFrameAt(100);
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(500);
    guest.frames.runFrameAt(600);
    await Effect.runPromise(Fiber.interrupt(attach));
    const totals = host.coop.debug().state?.totals ?? [];
    expect([
      guest.log,
      // Only the guest was attached: what its source read rode its steps, at 2 a step, to
      // the host's run too.
      [totals[0], (totals[1] ?? 0) > 0, (totals[1] ?? 0) % 2],
    ]).toStrictEqual([
      [
        "input",
        "seat 0 of [] draws no run",
        "seat 1 of [Host, Guest 1] draws a run",
        "dispose input",
        "dispose view",
      ],
      [0, true, 0],
    ]);
  });

  it("sends a command of the engine's simulation, and fails with the rejection the rules refused it with", async () => {
    const hub = fakeCoopRooms();
    const { host } = await lobbyOfTwo(hub);
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(200);
    const held = Effect.runFork(
      Effect.result(host.coop.send(new HoldPause({ held: true })))
    );
    const answered = Effect.runFork(
      Effect.result(host.coop.send(new AnswerOffer({ offer: 1, value: 3 })))
    );
    await vi.advanceTimersByTimeAsync(500);
    expect([
      await Effect.runPromise(Fiber.join(held)),
      await Effect.runPromise(Fiber.join(answered)),
      host.coop.debug().state?.held,
    ]).toStrictEqual([
      Result.succeed(undefined),
      Result.fail(new NothingOwed({ offer: 1 })),
      [true, false],
    ]);
  });

  it("stops quietly when the others leave a run that one of its `ends` events ended", async () => {
    const hub = fakeCoopRooms();
    const { host, guest } = await lobbyOfTwo(hub, 30);
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(2000);
    await run(host.coop.leave);
    await vi.advanceTimersByTimeAsync(12_000);
    expect([
      reported(guest.events),
      guest.events.filter((event) => event._tag === "SeatFailed"),
    ]).toStrictEqual([[new RunEnded({ totals: [0, 0] })], []]);
  });

  it("takes its types from the engine's simulation and from what it uses", () => {
    expectTypeOf(TestCoop.layer).toEqualTypeOf<
      Layer.Layer<TestCoop, never, CoopRooms | Log | Levels>
    >();
    const program = Effect.gen(function* () {
      const coop = yield* TestCoop;
      expectTypeOf(
        coop.send(new AnswerOffer({ offer: 1, value: 3 }))
      ).toEqualTypeOf<Effect.Effect<void, NothingOwed | Game.CommandDropped>>();
      expectTypeOf(coop.send(new HoldPause({ held: true }))).toEqualTypeOf<
        Effect.Effect<void, Game.CommandDropped>
      >();
      expectTypeOf(coop.debug().state).toEqualTypeOf<Game.StateOf<
        typeof TestGame
      > | null>();
      // @ts-expect-error -- not a command of the engine's simulation
      void coop.send(new RunEnded({ totals: [] }));
    });
    expect(Effect.isEffect(program)).toBe(true);
  });
});

// How an app hears a seat: one `match` for the client's own events and the run's.
describe("a Coop's match", () => {
  /** What an app would make of each event: here, a line of text. */
  const toLine = TestCoop.match({
    LobbyChanged: ({ code, players }) => `lobby ${code}: ${players.length}`,
    RunStarted: ({ slot }) => `started at ${slot}`,
    WaitingChanged: ({ waitingFor }) => `waiting for ${waitingFor.join("+")}`,
    SeatFailed: ({ reason }) => `failed: ${reason}`,
    run: {
      Score: () => undefined,
      OfferOpened: ({ offer, slot }, { local }) =>
        slot === local.slot ? `offer ${offer} is mine` : undefined,
      RunEnded: ({ totals }, { local }) =>
        `ended with ${totals[local.slot]} for ${local.names[local.slot]}`,
    },
  });
  const local = { slot: 1, names: ["Host", "Guest 1"] };
  const heard = (event: TestEvent): Event => ({
    _tag: "RunEvent",
    event,
    local,
  });

  it("handles the client's own events by their tags", () => {
    expect(
      [
        new Seat.LobbyChanged({
          role: "host",
          code: "K7MQ2X",
          self: "host",
          players: [{ id: "host", name: "Host", pick: "red" }],
          maxPlayers: 2,
          canStart: false,
        }),
        new Seat.RunStarted({ slot: 1, names: local.names }),
        new Seat.WaitingChanged({ waitingFor: ["Host"] }),
        new Seat.SeatFailed({ reason: "hostLost", message: "Lost the host." }),
      ].map(toLine)
    ).toStrictEqual([
      "lobby K7MQ2X: 1",
      "started at 1",
      "waiting for Host",
      "failed: hostLost",
    ]);
  });

  it("handles the run's events under `run`, each with the local player", () => {
    expect(
      [
        heard(new Score({ steps: 3, totals: [1, 2], owes: [false, false] })),
        heard(new OfferOpened({ offer: 1, slot: 0 })),
        heard(new OfferOpened({ offer: 1, slot: 1 })),
        heard(new RunEnded({ totals: [5, 6] })),
      ].map(toLine)
    ).toStrictEqual([
      undefined,
      undefined,
      "offer 1 is mine",
      "ended with 6 for Guest 1",
    ]);
    expectTypeOf(toLine).toEqualTypeOf<
      (event: Seat.CoopEvent<TestEvent>) => string | undefined
    >();
  });

  it("reserves no tag: a run may report events named as the client's own are", () => {
    class LobbyChanged extends Game.Event("LobbyChanged", {
      door: Schema.Int,
    }) {}
    class RunEvent extends Game.Event("RunEvent", { lap: Schema.Int }) {}
    class Doors extends Game.Simulation("Doors", {
      input: Game.PlayerInputs(Schema.Null),
      events: [LobbyChanged, RunEvent],
      create: () => ({ doors: 0 }),
      step: () => {},
    }) {}
    class DoorsEngine extends Game.Engine("DoorsEngine", {
      simulation: Doors,
      view: () => ({ render: () => {}, dispose: () => {} }),
      input: () => ({
        read: () => ({ players: [], leaving: [] }),
        dispose: () => {},
      }),
    }) {}
    class DoorsCoop extends Coop("DoorsCoop", {
      engine: DoorsEngine,
      input: () => ({ read: () => null, dispose: () => {} }),
      content: Effect.succeed(null),
      picks: () => ["one"],
      config: () => undefined,
      hash: (state) => state.doors,
    }) {}
    const toDoor = DoorsCoop.match({
      LobbyChanged: ({ code }) => `the client's lobby ${code}`,
      RunStarted: () => "started",
      WaitingChanged: () => "waiting",
      SeatFailed: () => "failed",
      run: {
        LobbyChanged: ({ door }) => `the game's door ${door}`,
        RunEvent: ({ lap }) => `the game's lap ${lap}`,
      },
    });
    expect([
      toDoor(
        new Seat.LobbyChanged({
          role: "guest",
          code: "K7MQ2X",
          self: "guest-1",
          players: [],
          maxPlayers: 4,
          canStart: false,
        })
      ),
      toDoor({
        _tag: "RunEvent",
        event: new LobbyChanged({ door: 3 }),
        local,
      }),
      toDoor({ _tag: "RunEvent", event: new RunEvent({ lap: 2 }), local }),
    ]).toStrictEqual([
      "the client's lobby K7MQ2X",
      "the game's door 3",
      "the game's lap 2",
    ]);
  });

  it("refuses cases that leave an event out, by type and when the event comes", () => {
    const own = {
      LobbyChanged: () => 1,
      RunStarted: () => 2,
      WaitingChanged: () => 3,
      SeatFailed: () => 4,
    };
    const everyRun = {
      Score: () => 5,
      OfferOpened: () => 6,
      RunEnded: () => 7,
    };
    // @ts-expect-error -- the run's events have no cases: `run` is missing
    const noRun = TestCoop.match(own);
    const noEnd = TestCoop.match({
      ...own,
      // @ts-expect-error -- RunEnded has no case
      run: { Score: () => 5, OfferOpened: () => 6 },
    });
    const { SeatFailed: _, ...noFailure } = own;
    // @ts-expect-error -- SeatFailed has no case
    const unfailing = TestCoop.match({ ...noFailure, run: everyRun });
    const end = heard(new RunEnded({ totals: [] }));
    expect(() => noRun(end)).toThrow(
      'Coop "TestCoop" has no case under `run` for the run\'s event "RunEnded"'
    );
    expect(() => noEnd(end)).toThrow(
      'Coop "TestCoop" has no case under `run` for the run\'s event "RunEnded"'
    );
    expect(() =>
      unfailing(new Seat.SeatFailed({ reason: "bug", message: "It broke." }))
    ).toThrow('Coop "TestCoop" has no case for the event "SeatFailed"');
  });
});

// What a `Coop` refuses: a type error first, then a throw as the game's module loads, for what
// a cast or plain JavaScript gets past the types.
describe("declaring a Coop", () => {
  const Move = Schema.Struct({ n: Schema.Number });
  class Counted extends Game.Event("Counted", { steps: Schema.Int }) {}
  class Elsewhere extends Game.Event("Elsewhere", { at: Schema.Int }) {}
  class Stepped extends Game.Event("Stepped", { steps: Schema.Int }) {}

  class Shared extends Game.Simulation("Shared", {
    input: Game.PlayerInputs(Move),
    events: [Counted],
    create: () => ({ steps: 0 }),
    step: (state) => {
      state.steps += 1;
    },
    sample: {
      event: Stepped,
      every: "100 millis",
      read: (state) => ({ steps: state.steps }),
    },
  }) {}
  class SharedEngine extends Game.Engine("SharedEngine", {
    simulation: Shared,
    view: () => ({ render: () => {}, dispose: () => {} }),
    input: () => ({
      read: () => ({ players: [], leaving: [] }),
      dispose: () => {},
    }),
  }) {}

  /** The rest of a definition over `SharedEngine`, with nothing to refuse. */
  const rest = {
    input: () => ({ read: () => ({ n: 1 }), dispose: () => {} }),
    content: Effect.succeed(null),
    picks: () => ["one"],
    config: () => undefined,
    hash: (state: { readonly steps: number }) => state.steps,
  };

  it("refuses an engine whose simulation one player plays", () => {
    class Solo extends Game.Simulation("Solo", {
      input: Move,
      create: () => ({ steps: 0 }),
      step: () => {},
    }) {}
    class SoloEngine extends Game.Engine("SoloEngine", {
      simulation: Solo,
      view: () => ({ render: () => {}, dispose: () => {} }),
      input: () => ({ read: () => ({ n: 1 }), dispose: () => {} }),
    }) {}
    expect(() =>
      // oxlint-disable-next-line declaration/class -- declares what the builder refuses, to read its message.
      Coop("SoloCoop", {
        // @ts-expect-error -- Solo's input was not declared with Game.PlayerInputs
        engine: SoloEngine,
        // @ts-expect-error -- so there is no one player's input to read
        input: () => ({ read: () => ({ n: 1 }), dispose: () => {} }),
        content: Effect.succeed(null),
        picks: () => ["one"],
        config: () => undefined,
        hash: () => 0,
      })
    ).toThrow(
      'Coop "SoloCoop" is declared with the engine "SoloEngine", whose simulation several players can\'t play. Simulation "Solo" can\'t seat several players: its `input` was not declared with Game.PlayerInputs. Declare `input: Game.PlayerInputs(OnePlayersInput)`, from the Schema of one player\'s input for one step.'
    );
  });

  it("refuses a players' input written by hand, which has no one-player Schema to read", () => {
    class ByHand extends Game.Simulation("ByHand", {
      input: Schema.Struct({
        players: Schema.Array(Schema.NullOr(Move)),
        leaving: Schema.Array(Schema.Int),
      }),
      create: () => ({ steps: 0 }),
      step: () => {},
    }) {}
    class ByHandEngine extends Game.Engine("ByHandEngine", {
      simulation: ByHand,
      view: () => ({ render: () => {}, dispose: () => {} }),
      input: () => ({
        read: () => ({ players: [], leaving: [] }),
        dispose: () => {},
      }),
    }) {}
    expect(() =>
      // oxlint-disable-next-line declaration/class -- declares what the builder refuses, to read its message.
      Coop("ByHandCoop", {
        // @ts-expect-error -- a struct with `players` and `leaving` is not a Game.PlayerInputs
        engine: ByHandEngine,
        // @ts-expect-error -- so there is no one player's input to read
        input: () => ({ read: () => ({ n: 1 }), dispose: () => {} }),
        content: Effect.succeed(null),
        picks: () => ["one"],
        config: () => undefined,
        hash: () => 0,
      })
    ).toThrow(
      'Coop "ByHandCoop" is declared with the engine "ByHandEngine", whose simulation several players can\'t play. Simulation "ByHand" can\'t seat several players'
    );
  });

  it("refuses an input source that reads the whole step's input: the engine's does that", () => {
    // oxlint-disable-next-line declaration/class -- declares what the types refuse; nothing is thrown, since a source is only made on attach.
    const declared = Coop("WholeStep", {
      ...rest,
      engine: SharedEngine,
      input: () => ({
        // @ts-expect-error -- one player's input is { n }, not { players, leaving }
        read: () => ({ players: [], leaving: [] }),
        dispose: () => {},
      }),
    });
    expect(declared.coopName).toBe("WholeStep");
  });

  it("refuses an `ends` entry the simulation doesn't report", () => {
    expect(() =>
      // oxlint-disable-next-line declaration/class -- declares what the builder refuses, to read its message.
      Coop("EndsElsewhere", {
        ...rest,
        engine: SharedEngine,
        // @ts-expect-error -- Elsewhere is not one of Shared's events
        ends: [Elsewhere],
      })
    ).toThrow(
      'Coop "EndsElsewhere" lists "Elsewhere" in `ends`, which the simulation "Shared" doesn\'t report. List the event a run ends with, one of the simulation\'s `events` (Counted).'
    );
  });

  it("refuses the simulation's sample in `ends`, which the types take for one of its events", () => {
    expect(() =>
      // oxlint-disable-next-line declaration/class -- declares what the builder refuses, to read its message.
      Coop("EndsAtOnce", { ...rest, engine: SharedEngine, ends: [Stepped] })
    ).toThrow(
      'Coop "EndsAtOnce" lists "Stepped" in `ends`, which is the sample of the simulation "Shared": a run reports it all the time, so every run would count as over at once. List the event a run ends with, one of the simulation\'s `events`.'
    );
  });

  it.each([1, 17, 2.5])(
    "refuses maxPlayers %s, a size no room has",
    (maxPlayers) => {
      expect(() =>
        // oxlint-disable-next-line declaration/class -- declares what the builder refuses, to read its message.
        Coop("Crowd", { ...rest, engine: SharedEngine, maxPlayers })
      ).toThrow(
        `Coop "Crowd" has maxPlayers ${maxPlayers}, a size no room has: a signalling room holds 2 to 16 players. Write a whole number from 2 to 16, or leave it out for 4.`
      );
    }
  );

  it("takes an `ends` entry the simulation reports, and every room size from 2 to 16", () => {
    // oxlint-disable-next-line declaration/class -- the same definition at each size, which a class statement can't loop over.
    const sizes = [2, 16].map(
      (maxPlayers) =>
        Coop("Sized", {
          ...rest,
          engine: SharedEngine,
          maxPlayers,
          ends: [Counted],
        }).coopName
    );
    expect(sizes).toStrictEqual(["Sized", "Sized"]);
  });
});
