import { Effect, Exit, Fiber, Result, Schema, Scope } from "effect";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";

import * as Game from "../../../src/game/index";
import * as Scenario from "../../../src/game/scenario";
import { MemoryNetwork, ScopedLockstepSession } from "../../../src/net/index";
import * as Testing from "../../../src/net/testing/index";
import {
  ManualTicker,
  PageTimers,
  TestGame,
} from "../../../src/net/testing/index";

// The test helpers' own rules: what the entry holds, the test game on a loop, its commands as
// scenarios, the manual ticker, and an Effect on a test's fake timers.

describe("arcadekit/net/testing", () => {
  // A game makes a Co-op client one way, from its `Coop`'s `layer`, and so does its test, over
  // these rooms and this ticker. The kit's own client tests make theirs from plain parts, which
  // stay in its tests (test/net/browser/internal/test-client.ts): a second way here would be
  // public API.
  it("holds a test's rooms, its ticker, its fake timers and a game to run, and no Co-op client of its own", () => {
    expect(Object.keys(Testing).toSorted()).toStrictEqual([
      "FakeCoopRooms",
      "ManualTicker",
      "PageTimers",
      "TestGame",
    ]);
  });
});

/**
 * A run of the test game on a loop: its state, what it reported but its samples, its last
 * sample, and a step, which takes the 100 ms a sample is due after.
 */
const startRun = (config: TestGame.Config) => {
  const loop = Game.makeLoop(TestGame.TestGame);
  const reported: TestGame.Event[] = [];
  let sampled: TestGame.Score | undefined;
  let nowMs = 0;
  loop.subscribe((event) => {
    if (event._tag === "Score") {
      sampled = event;
    } else {
      reported.push(event);
    }
  });
  loop.start(config, 1, nowMs);
  return {
    state: loop.state!,
    reported,
    /** Who still owes the open offer an answer, by slot, as the run's last sample says. */
    owes: () => sampled?.owes,
    stepAll: (
      players: readonly (TestGame.Input | null)[],
      leaving: readonly number[] = []
    ) => {
      nowMs += 100;
      loop.frame({ read: () => ({ players, leaving }) }, { steps: 1 }, nowMs);
    },
    /** `slot`'s player answers offer 1: the next step applies it. */
    answer: (slot: number, value: number) => {
      loop.send(new TestGame.AnswerOffer({ offer: 1, value }), slot);
    },
  };
};

describe("the test game", () => {
  const content = { ...TestGame.content, length: 5, offerEvery: 2 };
  const start = () => startRun({ content, picks: ["red", "blue"] });

  it("is a declared simulation several players play, with one player's input to send", () => {
    const decode = Schema.decodeUnknownResult(
      Game.playerInputSchema(TestGame.TestGame)
    );
    expect([
      TestGame.TestGame.kind,
      decode({ add: 1 }),
      Result.isFailure(decode({ add: "1" })),
    ]).toStrictEqual(["Simulation", Result.succeed({ add: 1 }), true]);
  });

  it("waits on an offer until each player answers it, and says in its sample who still owes one", () => {
    const { state, reported, owes, stepAll, answer } = start();
    stepAll([{ add: 1 }, { add: 2 }]);
    stepAll([{ add: 1 }, { add: 2 }]);
    const opened = [...reported];
    answer(1, 9);
    stepAll([{ add: 1 }, { add: 2 }]);
    const midway = [state.steps, owes()];
    answer(0, 4);
    stepAll([{ add: 1 }, { add: 2 }]);
    expect([
      opened,
      midway,
      state.steps,
      state.totals,
      state.bonus,
      owes(),
    ]).toStrictEqual([
      [
        new TestGame.OfferOpened({ offer: 1, slot: 0 }),
        new TestGame.OfferOpened({ offer: 1, slot: 1 }),
      ],
      [2, [true, false]],
      // The step that took the last answer played.
      3,
      [3, 6],
      [4, 9],
      [false, false],
    ]);
  });

  it("ends after its length, with every player's total", () => {
    const { state, reported, stepAll } = startRun({
      content: { ...content, offerEvery: 0 },
      picks: ["red", "blue"],
    });
    for (let i = 0; i < 7; i++) {
      stepAll([{ add: 1 }, { add: 3 }], i === 2 ? [1] : []);
    }
    expect([state.steps, reported]).toStrictEqual([
      5,
      [new TestGame.RunEnded({ totals: [5, 6] })],
    ]);
  });
});

describe("the test game's commands", () => {
  const scenario = Scenario.make(TestGame.TestGame);
  const content = { ...TestGame.content, length: 100, offerEvery: 2 };
  const config = { content, picks: ["red", "blue"] };
  const ones = { players: [{ add: 1 }, { add: 1 }], leaving: [] };

  /** Two steps of play: offer 1 opens for both players. */
  const untilOffered = [
    Scenario.given(config),
    Scenario.step(ones, 2),
    Scenario.reported(
      new TestGame.OfferOpened({ offer: 1, slot: 0 }),
      new TestGame.OfferOpened({ offer: 1, slot: 1 })
    ),
  ];

  it("takes each player's answer to the open offer, and plays on once both have answered", () =>
    scenario(
      untilOffered,
      Scenario.send(new TestGame.AnswerOffer({ offer: 1, value: 4 })),
      Scenario.step(ones),
      Scenario.state((state) =>
        expect([state.bonus, state.owes, state.steps]).toStrictEqual([
          [4, 0],
          [false, true],
          2,
        ])
      ),
      Scenario.send(new TestGame.AnswerOffer({ offer: 1, value: 9 }), 1),
      // Applied before the step, so the step that takes the last answer plays.
      Scenario.step(ones),
      Scenario.state((state) =>
        expect([state.bonus, state.owes, state.steps]).toStrictEqual([
          [4, 9],
          [false, false],
          3,
        ])
      ),
      Scenario.reported()
    ));

  it("refuses an answer to an offer its sender doesn't owe: another offer, none open, or answered already", () =>
    scenario(
      Scenario.given(config),
      Scenario.send(new TestGame.AnswerOffer({ offer: 1, value: 1 })),
      Scenario.step(ones, 2),
      Scenario.refused(new TestGame.NothingOwed({ offer: 1 })),
      Scenario.reported(
        new TestGame.OfferOpened({ offer: 1, slot: 0 }),
        new TestGame.OfferOpened({ offer: 1, slot: 1 })
      ),
      Scenario.send(new TestGame.AnswerOffer({ offer: 2, value: 1 })),
      Scenario.send(new TestGame.AnswerOffer({ offer: 1, value: 3 })),
      Scenario.send(new TestGame.AnswerOffer({ offer: 1, value: 5 })),
      Scenario.step(ones),
      Scenario.refused(
        new TestGame.NothingOwed({ offer: 2 }),
        new TestGame.NothingOwed({ offer: 1 })
      ),
      Scenario.state((state) => expect(state.bonus).toStrictEqual([3, 0]))
    ));

  it("starts on an offer when its content says so: create opens offer 1 for every player and reports it, and the run waits on their answers", () =>
    scenario(
      Scenario.given({
        content: { ...content, offerEvery: 0, offerAtStart: true },
        picks: config.picks,
      }),
      Scenario.reported(
        new TestGame.OfferOpened({ offer: 1, slot: 0 }),
        new TestGame.OfferOpened({ offer: 1, slot: 1 })
      ),
      Scenario.sampled(
        new TestGame.Score({ steps: 0, totals: [0, 0], owes: [true, true] })
      ),
      Scenario.step(ones, 2),
      Scenario.state((state) => expect(state.steps).toBe(0)),
      Scenario.send(new TestGame.AnswerOffer({ offer: 1, value: 4 })),
      Scenario.send(new TestGame.AnswerOffer({ offer: 1, value: 9 }), 1),
      Scenario.step(ones),
      Scenario.state((state) =>
        expect([state.bonus, state.owes, state.steps]).toStrictEqual([
          [4, 9],
          [false, false],
          1,
        ])
      ),
      Scenario.reported()
    ));

  it("holds the run while a player holds the pause, until it lets go or leaves", () =>
    scenario(
      Scenario.given({
        content: { ...content, offerEvery: 0 },
        picks: config.picks,
      }),
      Scenario.send(new TestGame.HoldPause({ held: true }), 1),
      Scenario.step(ones, 3),
      Scenario.state((state) =>
        expect([state.steps, state.held]).toStrictEqual([0, [false, true]])
      ),
      Scenario.send(new TestGame.HoldPause({ held: false }), 1),
      Scenario.step(ones),
      Scenario.state((state) => expect(state.steps).toBe(1)),
      Scenario.send(new TestGame.HoldPause({ held: true }), 1),
      Scenario.step(ones),
      // A player who leaves lets go of it in the step it leaves at.
      Scenario.step({ players: [{ add: 1 }, null], leaving: [1] }),
      Scenario.state((state) =>
        expect([state.steps, state.held]).toStrictEqual([2, [false, false]])
      )
    ));
});

describe(ManualTicker.make, () => {
  it("ticks each run it was started for, until that run stops", () => {
    const manual = ManualTicker.make();
    const ticks: string[] = [];
    const stopA = manual.ticker(() => ticks.push("a"));
    const stopB = manual.ticker(() => ticks.push("b"));
    ManualTicker.tick(manual);
    stopA();
    ManualTicker.tick(manual);
    const ticking = ManualTicker.ticking(manual);
    stopB();
    ManualTicker.tick(manual);
    expect([ticks, ticking, ManualTicker.ticking(manual)]).toStrictEqual([
      ["a", "b", "b"],
      1,
      0,
    ]);
  });
});

/** Resolves after at least `turns` turns of the microtask queue, with no timer. */
const microtaskTurns = async (turns: number): Promise<void> => {
  if (turns > 0) {
    await Promise.resolve();
    await microtaskTurns(turns - 1);
  }
};

/** `effect` on the page's timers, as a test on fake timers runs each of its Effects. */
const onPage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(PageTimers.layer));

describe("PageTimers.layer", () => {
  let scope: Scope.Closeable;

  /** A lone host's session of the test game, in the test's scope, made by `on`'s Effect. */
  const hostAlone = (on: typeof onPage) =>
    Effect.runPromise(
      on(
        ScopedLockstepSession.host({
          simulation: TestGame.TestGame,
          config: { content: TestGame.content, picks: ["red"] },
          contentHash: "content-1",
          transport: MemoryNetwork.connect(
            MemoryNetwork.make({ seed: 1 }),
            "host"
          ),
          local: { read: () => ({ add: 1 }) },
          hash: TestGame.hash,
          inputDelay: 2,
          hashEvery: 30,
          peers: [],
          seed: 1,
        }).pipe(Scope.provide(scope))
      )
    );

  beforeEach(() => {
    scope = Effect.runSync(Scope.make());
  });

  afterEach(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    vi.useRealTimers();
  });

  it("has an Effect read the faked time and sleep on the faked timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
    const log: string[] = [];
    const slept = Effect.runPromise(
      onPage(
        Effect.gen(function* () {
          const clock = yield* Effect.clockWith(Effect.succeed);
          const fromMs = Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000;
          yield* Effect.sleep("250 millis");
          log.push("woke");
          return Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000 - fromMs;
        })
      )
    );
    await vi.advanceTimersByTimeAsync(249);
    const early = [...log];
    await vi.advanceTimersByTimeAsync(1);
    expect([early, log, await slept]).toStrictEqual([[], ["woke"], 250]);
  });

  // A session steps by the time its Clock gives and its run ticks on the Clock's sleeps: on the
  // helper the two move together, as a page's do.
  it("steps a lockstep session by the faked time, which Effect's own Clock doesn't read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
    const faked = await hostAlone(onPage);
    // Effect's own Clock is on the real time, and how much of that passes here is the machine's
    // to say: a busy one takes long over a faked second. `Date` is not faked, so it measures it.
    const realFromMs = Date.now();
    const real = await hostAlone((effect) => effect);
    const runs = [
      Effect.runFork(onPage(faked.run())),
      // Its sleeps are on the faked `setTimeout` too, so it ticks as often; its time is not.
      Effect.runFork(real.run()),
    ];
    await vi.advanceTimersByTimeAsync(1000);
    const realSteps =
      (Date.now() - realFromMs) /
      (TestGame.TestGame.definition.stepSeconds * 1000);
    expect([
      // A second of 60 Hz steps, to the rounding of a step's length.
      faked.stepIndex >= 59 && faked.stepIndex <= 60,
      // The steps of the real time that passed, to a step, and not those of the faked second.
      real.stepIndex <= realSteps + 1,
    ]).toStrictEqual([true, true]);
    await Effect.runPromise(Fiber.interruptAll(runs));
  });

  it("runs fibers on microtasks, so none waits on a timer the test fakes", async () => {
    // Effect's own scheduler runs a fiber that yields on `setImmediate`: faked here, and never
    // advanced.
    vi.useFakeTimers({ toFake: ["setImmediate", "clearImmediate"] });
    const done: string[] = [];
    const yielding = (name: string) =>
      Effect.yieldNow.pipe(
        Effect.andThen(Effect.yieldNow),
        Effect.andThen(Effect.sync(() => done.push(name)))
      );
    const fibers = [
      Effect.runFork(onPage(yielding("on the helper"))),
      Effect.runFork(yielding("on Effect's own scheduler")),
    ];
    // Microtasks alone: no timer is advanced.
    await microtaskTurns(50);
    expect(done).toStrictEqual(["on the helper"]);
    vi.useRealTimers();
    await Effect.runPromise(Fiber.interruptAll(fibers));
  });

  it("changes nothing else of the Effect: what it gives, fails with and needs", () => {
    const effect = Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.void);
      return yield* Effect.fail("no" as const);
    });
    expectTypeOf(onPage(effect)).toEqualTypeOf<
      Effect.Effect<never, "no", Scope.Scope>
    >();
    expect(Effect.runSyncExit(onPage(Effect.scoped(effect)))).toStrictEqual(
      Exit.fail("no")
    );
  });
});
