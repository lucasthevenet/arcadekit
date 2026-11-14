import {
  Cause,
  Context,
  Data,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Result,
  Schema,
} from "effect";
import type { Scope } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import * as Game from "../../src/game/browser";
import { ManualFrames } from "../../src/game/testing";

/**
 * The reasons an exit failed with, each a `Fail`'s error or the reason itself. The engine's
 * methods are traced, so their failures carry their spans as annotations, which this leaves out.
 * A success is "succeeded", which no expected list equals.
 */
const failures = <A, E>(exit: Exit.Exit<A, E> | undefined) => {
  if (exit === undefined) {
    return "no exit";
  }
  return Exit.isSuccess(exit)
    ? "succeeded"
    : exit.cause.reasons.map((reason) =>
        Cause.isFailReason(reason) ? reason.error : reason
      );
};

// A game that counts its steps, declared the way a genre declares one, and an engine for it
// whose view and input log what the engine does with them. Frames run only when a test runs them.

class Counted extends Game.Event("Counted", { steps: Schema.Int }) {}
class TooFar extends Game.Rejection("TooFar", { limit: Schema.Int }) {}
class Jump extends Game.Command(
  "Jump",
  { by: Schema.Int },
  { rejects: [TooFar] }
) {}

const JUMP_LIMIT = 1000;

class Counter extends Game.Simulation("Counter", {
  // 1/64 s steps: frame times below are exact in floating point.
  stepSeconds: 1 / 64,
  input: Schema.Null,
  commands: [Jump],
  // With `bug`, every step of the run throws it, as a bug that repeats does.
  create: (
    config: { readonly from: number; readonly bug?: Error },
    { seed }
  ) => ({
    steps: config.from,
    seed,
    bug: config.bug,
  }),
  step: (state) => {
    if (state.bug !== undefined) {
      throw state.bug;
    }
    state.steps += 1;
  },
  apply: {
    Jump: (state, command) => {
      if (command.by > JUMP_LIMIT) {
        return new TooFar({ limit: JUMP_LIMIT });
      }
      state.steps += command.by;
    },
  },
  sample: {
    event: Counted,
    version: (state) => state.steps,
    read: (state) => ({ steps: state.steps }),
  },
}) {}

/** What the view and the input log to: the test's own service, to show the layer hands it over. */
class Log extends Context.Service<Log, string[]>()("test/Log") {}

class SheetMissing extends Data.TaggedError("SheetMissing")<{
  readonly message: string;
}> {}

/** What a test makes go wrong on attach. */
interface Faults {
  load?: SheetMissing;
  view?: Error;
  render?: Error;
  input?: Error;
  read?: Error;
  disposeInput?: Error;
}

class Trouble extends Context.Service<Trouble, Faults>()("test/Trouble") {}

/** Fails as an asset that can't be loaded does, while the test says so. */
const sheet = Effect.gen(function* () {
  const log = yield* Log;
  const faults = yield* Trouble;
  log.push("load sheet");
  if (faults.load !== undefined) {
    return yield* faults.load;
  }
  yield* Effect.addFinalizer(() => Effect.sync(() => log.push("released")));
  return "sheet";
});

class CounterEngine extends Game.Engine("CounterEngine", {
  simulation: Counter,
  uses: { log: Log, faults: Trouble, sheet },
  view: (container, { log, faults, sheet: loaded }) => {
    if (faults.view !== undefined) {
      throw faults.view;
    }
    log.push(`view ${container.id} from ${loaded}`);
    return {
      render: (state) => {
        if (faults.render !== undefined) {
          throw faults.render;
        }
        log.push(`render ${state?.steps ?? "null"}`);
      },
      dispose: () => log.push("dispose view"),
    };
  },
  input: (surface, { log, faults }) => {
    if (faults.input !== undefined) {
      throw faults.input;
    }
    log.push(`input ${surface.id}`);
    return {
      read: () => {
        if (faults.read !== undefined) {
          throw faults.read;
        }
        return null;
      },
      dispose: () => {
        log.push("dispose input");
        if (faults.disposeInput !== undefined) {
          throw faults.disposeInput;
        }
      },
    };
  },
}) {}

// A second game, for the cases that watch the frame clock. It reports that it started, and its
// sample is timed, so a log of what its listener heard and its view drew shows when the engine
// stepped and when it only drew.

class Started extends Game.Event("Started") {}
class Sampled extends Game.Event("Sampled", { steps: Schema.Int }) {}

class Timed extends Game.Simulation("Timed", {
  stepSeconds: 1 / 64,
  input: Schema.Null,
  events: [Started],
  create: (_config: null, { report }) => {
    report(new Started());
    return { steps: 0 };
  },
  step: (state) => {
    state.steps += 1;
  },
  // Every 10 ms. The frames below are further apart, so each one that steps is due a sample.
  sample: {
    event: Sampled,
    every: "10 millis",
    read: (state) => ({ steps: state.steps }),
  },
}) {}

class TimedEngine extends Game.Engine("TimedEngine", {
  simulation: Timed,
  uses: { log: Log },
  view: (container, { log }) => {
    log.push(`view ${container.id}`);
    return {
      render: (state) => log.push(`render ${state?.steps ?? "null"}`),
      dispose: () => log.push("dispose view"),
    };
  },
  input: (surface, { log }) => {
    log.push(`input ${surface.id}`);
    return { read: () => null, dispose: () => log.push("dispose input") };
  },
}) {}

// A third game, for the order a listener and a sender hear in. Its start, its command and each
// of its steps report, and its sample follows every frame that stepped, so one log of what a
// listener heard, what the view drew and where a sender went on shows that order.

class Opened extends Game.Event("Opened") {}
class Turned extends Game.Event("Turned", { to: Schema.Int }) {}
class Walked extends Game.Event("Walked", { step: Schema.Int }) {}
class Faced extends Game.Event("Faced", {
  facing: Schema.Int,
  steps: Schema.Int,
}) {}
class NoSuchWay extends Game.Rejection("NoSuchWay") {}
class Turn extends Game.Command(
  "Turn",
  { to: Schema.Int },
  { rejects: [NoSuchWay] }
) {}

class Walk extends Game.Simulation("Walk", {
  stepSeconds: 1 / 64,
  input: Schema.Null,
  events: [Opened, Turned, Walked],
  commands: [Turn],
  // With `trip`, the step of that number throws, as a bug in the rules does.
  create: (config: { readonly trip?: number }, { report }) => {
    report(new Opened());
    return { facing: 0, steps: 0, trip: config.trip };
  },
  step: (state, _input, { report, step }) => {
    if (step === state.trip) {
      throw new Error("tripped");
    }
    state.steps += 1;
    report(new Walked({ step }));
  },
  apply: {
    Turn: (state, command, { report }) => {
      if (command.to > 3) {
        return new NoSuchWay();
      }
      state.facing = command.to;
      report(new Turned({ to: command.to }));
    },
  },
  sample: {
    event: Faced,
    version: (state) => state.steps,
    read: (state) => ({ facing: state.facing, steps: state.steps }),
  },
}) {}

class WalkEngine extends Game.Engine("WalkEngine", {
  simulation: Walk,
  uses: { log: Log },
  view: (_container, { log }) => ({
    // It can't draw a walker that faces 3, as a view with a bug can't draw some state.
    render: (state) => {
      if (state?.facing === 3) {
        throw new Error("can't draw 3");
      }
      log.push(`draw ${state?.steps ?? "no run"}`);
    },
    dispose: () => {},
  }),
  input: () => ({ read: () => null, dispose: () => {} }),
}) {}

type WalkService = Context.Service.Shape<typeof WalkEngine>;

/**
 * Attaches the walking game's engine on `frames` and logs what a listener hears beside what the
 * view draws, runs `drive` with the log, then closes everything. Returns the log and how the
 * attach ended, if it did while `drive` ran.
 */
const playWalk = async (
  frames: ManualFrames.ManualFrames,
  drive: (
    engine: WalkService,
    log: string[]
  ) => Effect.Effect<void, never, Scope.Scope>
) => {
  const log: string[] = [];
  let attach: Exit.Exit<never, unknown> | undefined;
  const layer = WalkEngine.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Game.Frames, frames),
        Layer.succeed(Log, log)
      )
    )
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* WalkEngine;
        yield* engine.listen(
          Walk.match({
            Opened: () => log.push("heard: opened"),
            Turned: ({ to }) => log.push(`heard: turned to ${to}`),
            Walked: ({ step }) => log.push(`heard: walked step ${step}`),
            Faced: ({ facing, steps }) =>
              log.push(`heard: facing ${facing} after ${steps}`),
          })
        );
        const fiber = yield* Effect.forkScoped(engine.attach(element), {
          startImmediately: true,
        });
        yield* drive(engine, log);
        attach = fiber.pollUnsafe();
      })
    ).pipe(Effect.provide(layer))
  );
  return { log, attach };
};

/**
 * Sends a turn on a fiber of the caller's, and logs how it ended on the line after the send: a
 * line of the log that comes before it was there when the send completed.
 */
const turning = (engine: WalkService, log: string[], to: number) =>
  Effect.forkChild(
    engine.send(new Turn({ to })).pipe(
      Effect.match({
        onSuccess: () => log.push("sender: taken"),
        onFailure: (error) =>
          log.push(
            error._tag === "CommandDropped"
              ? `sender: dropped, ${error.reason}`
              : `sender: refused, ${error._tag}`
          ),
      })
    ),
    { startImmediately: true }
  );

/** An engine whose view keeps what it was made with: the local player, as the engine seats it. */
const seats: Game.LocalPlayer[] = [];

class SeatedEngine extends Game.Engine("SeatedEngine", {
  simulation: Counter,
  view: (_container, _uses, { local }) => {
    seats.push(local);
    return { render: () => {}, dispose: () => {} };
  },
  input: () => ({ read: () => null, dispose: () => {} }),
}) {}

const element = { id: "game" } as HTMLElement;

type CounterService = Context.Service.Shape<typeof CounterEngine>;

/**
 * Runs `drive` with the engine, the frames it draws on and its log, then closes everything.
 * Returns the log.
 */
const play = async (
  drive: (
    engine: CounterService,
    frames: ManualFrames.ManualFrames,
    log: string[]
  ) => Effect.Effect<void, never, Scope.Scope>,
  faults: Faults = {}
) => {
  const frames = ManualFrames.make();
  const log: string[] = [];
  const layer = CounterEngine.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Game.Frames, frames),
        Layer.succeed(Log, log),
        Layer.succeed(Trouble, faults)
      )
    )
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* CounterEngine;
        yield* drive(engine, frames, log);
      })
    ).pipe(Effect.provide(layer))
  );
  return log;
};

/** Attaches the engine on a fiber of the caller's scope. It has asked for a frame on return. */
const attached = (engine: CounterService) =>
  Effect.forkScoped(engine.attach(element), { startImmediately: true });

/**
 * Checks that an attach ended with exactly `expected`: one typed failure of its class, with its
 * `message` and, as its `cause`, the very value that was thrown. The two fields are checked on
 * the error itself: an Effect tagged error keeps both off its enumerable keys, so
 * `toStrictEqual` holds the exit's shape and the error's class, and passes whatever they are.
 */
const expectFailure = (
  exit: Exit.Exit<never, unknown> | undefined,
  expected: Game.AttachError | Game.GameCrashed
) => {
  expect(failures(exit)).toStrictEqual([expected]);
  const error = Option.getOrUndefined(
    Exit.findErrorOption(exit ?? Exit.void)
  ) as { readonly cause?: unknown } | undefined;
  expect(error).toMatchObject({
    _tag: expected._tag,
    message: expected.message,
  });
  expect(error?.cause).toBe(expected.cause);
};

/**
 * Attaches the timed game's engine on `frames`, logs what a listener hears beside what the view
 * and the input do, runs `drive`, then closes everything. Returns the log.
 */
const playTimed = async (
  frames: ManualFrames.ManualFrames,
  drive: (
    engine: Context.Service.Shape<typeof TimedEngine>
  ) => Effect.Effect<void, never, Scope.Scope>
) => {
  const log: string[] = [];
  const layer = TimedEngine.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Game.Frames, frames),
        Layer.succeed(Log, log)
      )
    )
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* TimedEngine;
        yield* engine.listen(
          Timed.match({
            Started: () => log.push("started"),
            Sampled: ({ steps }) => log.push(`sample ${steps}`),
          })
        );
        yield* Effect.forkScoped(engine.attach(element), {
          startImmediately: true,
        });
        yield* drive(engine);
      })
    ).pipe(Effect.provide(layer))
  );
  return log;
};

describe("Game.Engine", () => {
  it("runs what it uses on attach, then makes the view and the input, steps and draws each frame, and disposes on detach", async () => {
    const log = await play((engine, frames) =>
      Effect.gen(function* () {
        yield* engine.start({ from: 10 }, { seed: 1 });
        yield* attached(engine);
        // 1/64 s after attach: one step.
        ManualFrames.runFrameAt(frames, 15.625);
        ManualFrames.runFrameAt(frames, 31.25);
      })
    );
    expect(log).toStrictEqual([
      "load sheet",
      "view game from sheet",
      "input game",
      "render 11",
      "render 12",
      "dispose input",
      "dispose view",
      "released",
    ]);
  });

  it("tells the view which seat is the local player's: slot 0, and nobody to name", async () => {
    seats.length = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* SeatedEngine;
          yield* Effect.forkScoped(engine.attach(element), {
            startImmediately: true,
          });
        })
      ).pipe(
        Effect.provide(SeatedEngine.layer),
        Effect.provide(Layer.succeed(Game.Frames, ManualFrames.make()))
      )
    );
    expect(seats).toStrictEqual([{ slot: 0, names: [] }]);
  });

  it("starts a run with the seed it is given, or a random 32-bit one", async () => {
    const seeds: number[] = [];
    class Seeded extends Game.Simulation("Seeded", {
      input: Schema.Null,
      create: (_config: null, { seed }) => {
        seeds.push(seed);
        return {};
      },
      step: () => {},
    }) {}
    class SeededEngine extends Game.Engine("SeededEngine", {
      simulation: Seeded,
      view: () => ({ render: () => {}, dispose: () => {} }),
      input: () => ({ read: () => null, dispose: () => {} }),
    }) {}
    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* SeededEngine;
        yield* engine.start(null, { seed: 42 });
        yield* engine.start(null);
      }).pipe(Effect.provide(SeededEngine.layer))
    );
    expect(seeds[0]).toBe(42);
    expect(Number.isInteger(seeds[1])).toBe(true);
    expect(seeds[1]).toBeGreaterThanOrEqual(0);
    expect(seeds[1]).toBeLessThan(2 ** 32);
  });

  it("reports the run's events to a listener while its scope is open", async () => {
    const heard: Counted[] = [];
    await play((engine, frames) =>
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* engine.listen((event) => heard.push(event));
            yield* engine.start({ from: 0 }, { seed: 1 });
            yield* attached(engine);
            ManualFrames.runFrameAt(frames, 15.625);
          })
        );
        yield* attached(engine);
        // The listener's scope has closed: this step's sample reaches no one.
        ManualFrames.runFrameAt(frames, 31.25);
      })
    );
    expect(heard).toStrictEqual([
      new Counted({ steps: 0 }),
      new Counted({ steps: 1 }),
    ]);
  });

  it("sends a command, which the next step applies; the send completes then", async () => {
    const done: boolean[] = [];
    const log = await play((engine, frames) =>
      Effect.gen(function* () {
        yield* engine.start({ from: 0 }, { seed: 1 });
        yield* attached(engine);
        const sent = yield* Effect.forkChild(
          engine.send(new Jump({ by: 100 })),
          { startImmediately: true }
        );
        // Nothing has stepped yet, so the rules haven't seen it.
        done.push(sent.pollUnsafe() !== undefined);
        ManualFrames.runFrameAt(frames, 15.625);
        done.push(Exit.isSuccess(yield* Fiber.await(sent)));
      })
    );
    expect(done).toStrictEqual([false, true]);
    expect(log).toContain("render 101");
  });

  it("goes on after a send once its frame has drawn, so a run started there begins at its first step", async () => {
    const log = await play((engine, frames, lines) =>
      Effect.gen(function* () {
        yield* engine.start({ from: 0 }, { seed: 1 });
        yield* attached(engine);
        const sender = yield* Effect.forkChild(
          Effect.gen(function* () {
            yield* engine.send(new Jump({ by: 100 }));
            lines.push("after the send");
            yield* engine.start({ from: 500 }, { seed: 2 });
          }),
          { startImmediately: true }
        );
        ManualFrames.runFrameAt(frames, 15.625);
        yield* Fiber.await(sender);
        ManualFrames.runFrameAt(frames, 31.25);
      })
    );
    // The new run steps once in the frame after it started: its clock is its own.
    expect(log.slice(3, 6)).toStrictEqual([
      "render 101",
      "after the send",
      "render 501",
    ]);
  });

  it("ends the run of a frame that threw before a dropped sender goes on, so a run it starts then stays", async () => {
    const faults: Faults = {};
    const log = await play(
      (engine, frames) =>
        Effect.gen(function* () {
          yield* engine.start({ from: 0 }, { seed: 1 });
          const crashing = yield* attached(engine);
          const sender = yield* Effect.forkChild(
            engine
              .send(new Jump({ by: 100 }))
              .pipe(
                Effect.catchTag("CommandDropped", () =>
                  engine.start({ from: 700 }, { seed: 2 })
                )
              ),
            { startImmediately: true }
          );
          // The input throws before the step applies the command.
          faults.read = new Error("no gamepad");
          ManualFrames.runFrameAt(frames, 15.625);
          yield* Fiber.await(crashing);
          yield* Fiber.await(sender);
          delete faults.read;
          yield* attached(engine);
          ManualFrames.runFrameAt(frames, 31.25);
        }),
      faults
    );
    expect(log.filter((line) => line.startsWith("render"))).toStrictEqual([
      "render 701",
    ]);
  });

  it("fails a send with the rejection the rules refused it with, and leaves the run as it was", async () => {
    let exit: Exit.Exit<void, unknown> | undefined;
    const log = await play((engine, frames) =>
      Effect.gen(function* () {
        yield* engine.start({ from: 0 }, { seed: 1 });
        yield* attached(engine);
        const sent = yield* Effect.forkChild(
          engine.send(new Jump({ by: 5000 })),
          { startImmediately: true }
        );
        ManualFrames.runFrameAt(frames, 15.625);
        exit = yield* Fiber.await(sent);
      })
    );
    expect(failures(exit)).toStrictEqual([new TooFar({ limit: JUMP_LIMIT })]);
    // The step ran; the jump did not.
    expect(log).toContain("render 1");
  });

  it("fails a send with CommandDropped when there is no run, or the run stops first", async () => {
    const exits: Exit.Exit<void, unknown>[] = [];
    await play((engine) =>
      Effect.gen(function* () {
        exits.push(yield* Effect.exit(engine.send(new Jump({ by: 1 }))));
        yield* engine.start({ from: 0 }, { seed: 1 });
        const sent = yield* Effect.forkChild(engine.send(new Jump({ by: 1 })), {
          startImmediately: true,
        });
        yield* engine.stop;
        exits.push(yield* Fiber.await(sent));
      })
    );
    expect(exits.map(failures)).toStrictEqual([
      [new Game.CommandDropped({ command: "Jump", reason: "noRun" })],
      [new Game.CommandDropped({ command: "Jump", reason: "runEnded" })],
    ]);
  });

  it("takes a command back when its send is interrupted before the step", async () => {
    const log = await play((engine, frames) =>
      Effect.gen(function* () {
        yield* engine.start({ from: 0 }, { seed: 1 });
        yield* attached(engine);
        const sent = yield* Effect.forkChild(
          engine.send(new Jump({ by: 100 })),
          { startImmediately: true }
        );
        yield* Fiber.interrupt(sent);
        ManualFrames.runFrameAt(frames, 15.625);
      })
    );
    expect(log).toContain("render 1");
    expect(log).not.toContain("render 101");
  });

  it("types a send's failure as the command's rejections and CommandDropped", async () => {
    await play((engine) =>
      Effect.sync(() => {
        // Made, never run: an Effect does nothing until it is.
        const sent = engine.send(new Jump({ by: 1 }));
        type Failure = Effect.Error<typeof sent>;
        expectTypeOf<Failure>().toExtend<
          | { readonly _tag: "TooFar"; readonly limit: number }
          | Game.CommandDropped
        >();
        expectTypeOf<TooFar>().toExtend<Failure>();
        expectTypeOf<Game.CommandDropped>().toExtend<Failure>();
      })
    );
    expect(TooFar.tag).toBe("TooFar");
  });

  it("draws without stepping while paused, and no state after stop", async () => {
    const log = await play((engine, frames) =>
      Effect.gen(function* () {
        yield* engine.start({ from: 0 }, { seed: 1 });
        yield* attached(engine);
        yield* engine.setPaused(true);
        ManualFrames.runFrameAt(frames, 15.625);
        yield* engine.setPaused(false);
        ManualFrames.runFrameAt(frames, 31.25);
        yield* engine.stop;
        ManualFrames.runFrameAt(frames, 46.875);
      })
    );
    expect(log.filter((line) => line.startsWith("render"))).toStrictEqual([
      "render 0",
      "render 1",
      "render null",
    ]);
  });

  it("fails to attach with the error of what it uses, and attaches once that is fixed", async () => {
    const faults: Faults = {
      load: new SheetMissing({ message: "no sheet" }),
    };
    const exits: Exit.Exit<never, unknown>[] = [];
    const log = await play(
      (engine, frames) =>
        Effect.gen(function* () {
          exits.push(yield* Effect.exit(engine.attach(element)));
          delete faults.load;
          yield* attached(engine);
          ManualFrames.runFrameAt(frames, 15.625);
        }),
      faults
    );
    expect(exits.map(failures)).toStrictEqual([
      [new SheetMissing({ message: "no sheet" })],
    ]);
    expect(log).toStrictEqual([
      "load sheet",
      "load sheet",
      "view game from sheet",
      "input game",
      "render null",
      "dispose input",
      "dispose view",
      "released",
    ]);
  });

  it("fails to attach with AttachError when the view can't be made", async () => {
    const cause = new Error("no WebGL");
    let exit: Exit.Exit<never, unknown> | undefined;
    const log = await play(
      (engine) =>
        Effect.gen(function* () {
          exit = yield* Effect.exit(engine.attach(element));
        }),
      { view: cause }
    );
    expectFailure(exit, new Game.AttachError({ message: "no WebGL", cause }));
    // Nothing was made, so nothing but what the attach used is released.
    expect(log).toStrictEqual(["load sheet", "released"]);
  });

  it("fails with GameCrashed when a frame throws: that frame is the last and the run ends", async () => {
    const cause = new Error("lost context");
    const faults: Faults = {};
    let exit: Exit.Exit<never, unknown> | undefined;
    const log = await play(
      (engine, frames) =>
        Effect.gen(function* () {
          yield* engine.start({ from: 0 }, { seed: 1 });
          const fiber = yield* attached(engine);
          faults.render = cause;
          ManualFrames.runFrameAt(frames, 15.625);
          exit = yield* Fiber.await(fiber);
          expect(ManualFrames.waiting(frames)).toBe(false);
          delete faults.render;
          yield* attached(engine);
          ManualFrames.runFrameAt(frames, 31.25);
        }),
      faults
    );
    expectFailure(
      exit,
      new Game.GameCrashed({ message: "lost context", cause })
    );
    // The crash detached it; attached again, there is no run to draw.
    expect(log).toStrictEqual([
      "load sheet",
      "view game from sheet",
      "input game",
      "dispose input",
      "dispose view",
      "released",
      "load sheet",
      "view game from sheet",
      "input game",
      "render null",
      "dispose input",
      "dispose view",
      "released",
    ]);
  });

  it("dies when attached again while attached, a programming error, and keeps drawing", async () => {
    let second: Exit.Exit<never, unknown> | undefined;
    const log = await play((engine, frames) =>
      Effect.gen(function* () {
        yield* attached(engine);
        second = yield* Effect.exit(engine.attach(element));
        ManualFrames.runFrameAt(frames, 15.625);
      })
    );
    // The defect names the engine and says what to do.
    expect(
      Result.map(
        Exit.findDefect(second ?? Exit.void),
        (defect) => (defect as Error).message
      )
    ).toStrictEqual(
      Result.succeed(
        'Engine "CounterEngine" is already attached to an element. An engine draws into one element at a time: interrupt the first attach, which detaches it, before attaching again.'
      )
    );
    // The second attach made nothing, and the first one drew its frame.
    expect(log).toStrictEqual([
      "load sheet",
      "view game from sheet",
      "input game",
      "render null",
      "dispose input",
      "dispose view",
      "released",
    ]);
  });
});

// `engine.listen` is the loop's `subscribe`, called inside the frame, and `engine.send` is told
// once the loop is out of that frame, then resumes after a yield. So the order is fixed: by the
// line after a send, a listener has been called with everything the frame of the command's
// step reported.
describe("what a listener has heard when a send completes", () => {
  it("is everything the frame of the command's step reported: the events of each of its steps, then its sample; the frame has drawn too", async () => {
    const frames = ManualFrames.make();
    const { log } = await playWalk(frames, (engine, lines) =>
      Effect.gen(function* () {
        yield* engine.start({});
        lines.length = 0;
        const sender = yield* turning(engine, lines, 2);
        // Nothing has stepped, so nothing was heard and the sender waits.
        lines.push(`before the frame: ${sender.pollUnsafe() === undefined}`);
        // 3/64 s after attach: three steps in one frame. The first applies the turn.
        ManualFrames.runFrameAt(frames, 46.875);
        yield* Fiber.await(sender);
      })
    );
    expect(log).toStrictEqual([
      "before the frame: true",
      "heard: turned to 2",
      "heard: walked step 0",
      "heard: walked step 1",
      "heard: walked step 2",
      "heard: facing 2 after 3",
      "draw 3",
      "sender: taken",
    ]);
  });

  it("is that frame's events and sample when the rules refused the command, which reported nothing itself", async () => {
    const frames = ManualFrames.make();
    const { log } = await playWalk(frames, (engine, lines) =>
      Effect.gen(function* () {
        yield* engine.start({});
        lines.length = 0;
        const sender = yield* turning(engine, lines, 9);
        ManualFrames.runFrameAt(frames, 15.625);
        yield* Fiber.await(sender);
      })
    );
    expect(log).toStrictEqual([
      "heard: walked step 0",
      "heard: facing 0 after 1",
      "draw 1",
      "sender: refused, NoSuchWay",
    ]);
  });

  it("is the same after a wait: a send made while paused completes after the first frame that steps", async () => {
    const frames = ManualFrames.make();
    const { log } = await playWalk(frames, (engine, lines) =>
      Effect.gen(function* () {
        yield* engine.start({});
        lines.length = 0;
        yield* engine.setPaused(true);
        const sender = yield* turning(engine, lines, 1);
        ManualFrames.runFrameAt(frames, 15.625);
        yield* Effect.yieldNow;
        lines.push(`still waiting: ${sender.pollUnsafe() === undefined}`);
        yield* engine.setPaused(false);
        ManualFrames.runFrameAt(frames, 31.25);
        yield* Fiber.await(sender);
      })
    );
    expect(log).toStrictEqual([
      "draw 0",
      "still waiting: true",
      "heard: turned to 1",
      "heard: walked step 0",
      "heard: facing 1 after 1",
      "draw 1",
      "sender: taken",
    ]);
  });

  it("is the new run's start, for a send that run dropped; a stop and a send with no run report nothing", async () => {
    const frames = ManualFrames.make();
    const { log } = await playWalk(frames, (engine, lines) =>
      Effect.gen(function* () {
        yield* engine.start({});
        lines.length = 0;
        const overtaken = yield* turning(engine, lines, 1);
        yield* engine.start({});
        yield* Fiber.await(overtaken);
        lines.push("-- stop");
        const stopped = yield* turning(engine, lines, 1);
        yield* engine.stop;
        yield* Fiber.await(stopped);
        lines.push("-- no run");
        yield* Fiber.await(yield* turning(engine, lines, 1));
      })
    );
    expect(log).toStrictEqual([
      "heard: opened",
      "heard: facing 0 after 0",
      "sender: dropped, runEnded",
      "-- stop",
      "sender: dropped, runEnded",
      "-- no run",
      "sender: dropped, noRun",
    ]);
  });

  // The one exception: a frame that throws before its listeners have heard it all. A command a
  // step of it had applied before the throw was still taken, and its sender is told so. A step
  // that throws is the first way: what the frame had reported is discarded with its run.
  it("is nothing of a frame a step threw in, though the sender of a command it took hears that it was taken", async () => {
    const frames = ManualFrames.make();
    const { log, attach } = await playWalk(frames, (engine, lines) =>
      Effect.gen(function* () {
        // The second step of the run throws.
        yield* engine.start({ trip: 1 });
        lines.length = 0;
        const sender = yield* turning(engine, lines, 2);
        // Two steps in one frame: the first applies the turn and reports, the second throws.
        ManualFrames.runFrameAt(frames, 31.25);
        yield* Fiber.await(sender);
        yield* Effect.yieldNow;
      })
    );
    expect(log).toStrictEqual(["sender: taken"]);
    // The app hears of the crash from `attach`, which that frame ended.
    expect(
      Option.getOrUndefined(Exit.findErrorOption(attach ?? Exit.void))
    ).toMatchObject({ _tag: "GameCrashed", message: "tripped" });
  });

  // A listener that throws is the other: the telling ends there.
  it("is what was told before the throw, of a frame a listener threw in: that event for the listeners before it, and nothing after", async () => {
    const frames = ManualFrames.make();
    const { log, attach } = await playWalk(frames, (engine, lines) =>
      Effect.gen(function* () {
        yield* engine.start({});
        // A second listener, which throws on a step's event, and a third after it.
        yield* engine.listen((event) => {
          if (event._tag === "Walked") {
            throw new Error("deaf to steps");
          }
        });
        yield* engine.listen((event) =>
          lines.push(`the third heard: ${event._tag}`)
        );
        lines.length = 0;
        const sender = yield* turning(engine, lines, 2);
        // One step: the turn's event is told, then the step's, which the second throws on.
        ManualFrames.runFrameAt(frames, 15.625);
        yield* Fiber.await(sender);
        yield* Effect.yieldNow;
      })
    );
    expect(log).toStrictEqual([
      "heard: turned to 2",
      "the third heard: Turned",
      "heard: walked step 0",
      "sender: taken",
    ]);
    expect(
      Option.getOrUndefined(Exit.findErrorOption(attach ?? Exit.void))
    ).toMatchObject({ _tag: "GameCrashed", message: "deaf to steps" });
  });

  // No exception: a render that throws crashes the engine too, after everything was told.
  it("is all of a frame whose render threw: the view draws after the listeners have heard the frame", async () => {
    const frames = ManualFrames.make();
    const { log, attach } = await playWalk(frames, (engine, lines) =>
      Effect.gen(function* () {
        yield* engine.start({});
        lines.length = 0;
        // The view can't draw the way this turns to.
        const sender = yield* turning(engine, lines, 3);
        ManualFrames.runFrameAt(frames, 15.625);
        yield* Fiber.await(sender);
        yield* Effect.yieldNow;
      })
    );
    expect(log).toStrictEqual([
      "heard: turned to 3",
      "heard: walked step 0",
      "heard: facing 3 after 1",
      "sender: taken",
    ]);
    expect(
      Option.getOrUndefined(Exit.findErrorOption(attach ?? Exit.void))
    ).toMatchObject({ _tag: "GameCrashed", message: "can't draw 3" });
  });
});

describe("an attached engine's frames", () => {
  it("draws until its scope closes, then cancels the frame it asked for: a later frame draws nothing", async () => {
    const frames = ManualFrames.make();
    const log = await playTimed(frames, () =>
      Effect.sync(() => {
        ManualFrames.runFrameAt(frames, 15.625);
        // Each frame asks for the next one.
        expect(ManualFrames.waiting(frames)).toBe(true);
      })
    );
    // Closing the scope cancelled that request, so a later frame draws nothing.
    expect(ManualFrames.waiting(frames)).toBe(false);
    ManualFrames.runFrameAt(frames, 31.25);
    expect(log).toStrictEqual([
      "view game",
      "input game",
      "render null",
      "dispose input",
      "dispose view",
    ]);
  });

  it("ends the run on stop: the view then draws no state, and nothing steps or samples", async () => {
    const frames = ManualFrames.make();
    const log = await playTimed(frames, (engine) =>
      Effect.gen(function* () {
        yield* engine.start(null, { seed: 1 });
        // 1/64 s after attach: one step.
        ManualFrames.runFrameAt(frames, 15.625);
        yield* engine.stop;
        ManualFrames.runFrameAt(frames, 31.25);
        ManualFrames.runFrameAt(frames, 46.875);
      })
    );
    expect(log).toStrictEqual([
      "view game",
      "input game",
      "started",
      "sample 0",
      "sample 1",
      "render 1",
      // Stopped: the view draws no state. Nothing steps or samples.
      "render null",
      "render null",
      "dispose input",
      "dispose view",
    ]);
  });

  it("runs no steps and no timed samples while paused, keeps drawing, and resumes when unpaused", async () => {
    const frames = ManualFrames.make();
    const log = await playTimed(frames, (engine) =>
      Effect.gen(function* () {
        yield* engine.start(null, { seed: 1 });
        ManualFrames.runFrameAt(frames, 15.625);
        yield* engine.setPaused(true);
        ManualFrames.runFrameAt(frames, 31.25);
        ManualFrames.runFrameAt(frames, 46.875);
        yield* engine.setPaused(false);
        ManualFrames.runFrameAt(frames, 62.5);
      })
    );
    expect(log).toStrictEqual([
      "view game",
      "input game",
      "started",
      "sample 0",
      "sample 1",
      "render 1",
      // Paused: the view still draws the run. Nothing steps or samples.
      "render 1",
      "render 1",
      // Unpaused: one step for the 1/64 s since the last frame. Paused time doesn't count.
      "sample 2",
      "render 2",
      "dispose input",
      "dispose view",
    ]);
  });

  it("starts a run unpaused, so a restart from a pause steps", async () => {
    const frames = ManualFrames.make();
    const log = await playTimed(frames, (engine) =>
      Effect.gen(function* () {
        yield* engine.start(null, { seed: 1 });
        ManualFrames.runFrameAt(frames, 15.625);
        yield* engine.setPaused(true);
        yield* engine.start(null, { seed: 2 });
        ManualFrames.runFrameAt(frames, 31.25);
      })
    );
    expect(log).toStrictEqual([
      "view game",
      "input game",
      "started",
      "sample 0",
      "sample 1",
      "render 1",
      // The new run, started while the old one was paused: it steps on the next frame.
      "started",
      "sample 0",
      "sample 1",
      "render 1",
      "dispose input",
      "dispose view",
    ]);
  });

  it("counts a first frame timed before attach as no time, so the next frame still steps", async () => {
    const frames = ManualFrames.make();
    // Attach at 100 ms. requestAnimationFrame passes the time its frame began, which can be
    // before then.
    ManualFrames.runFrameAt(frames, 100);
    const log = await playTimed(frames, (engine) =>
      Effect.gen(function* () {
        yield* engine.start(null, { seed: 1 });
        ManualFrames.runFrameAt(frames, 50);
        ManualFrames.runFrameAt(frames, 65.625);
      })
    );
    expect(log).toStrictEqual([
      "view game",
      "input game",
      "started",
      "sample 0",
      "render 0",
      // 1/64 s after the first frame: one step. No sample is due: these frames are timed
      // within 10 ms of the start's sample at 100 ms.
      "render 1",
      "dispose input",
      "dispose view",
    ]);
  });

  it("runs at most five steps in a frame after a long gap, and drops the rest", async () => {
    const log = await play((engine, frames) =>
      Effect.gen(function* () {
        yield* engine.start({ from: 0 }, { seed: 1 });
        yield* attached(engine);
        // Ten seconds in a hidden tab, on 1/64 s steps: five run, and the rest is dropped, so
        // the next frame owes its own step and no more.
        ManualFrames.runFrameAt(frames, 10_000);
        ManualFrames.runFrameAt(frames, 10_015.625);
      })
    );
    expect(log.filter((line) => line.startsWith("render"))).toStrictEqual([
      "render 5",
      "render 6",
    ]);
  });

  it("counts at most a quarter of a second of a long gap between frames", async () => {
    const frames = ManualFrames.make();
    const drawn: (number | null)[] = [];
    // 1/16 s steps: a quarter of a second is four of them, under the five a frame may run, so
    // the steps a long gap runs show that the time counted is what stopped them.
    class Slow extends Game.Simulation("Slow", {
      stepSeconds: 1 / 16,
      input: Schema.Null,
      create: (_config: null) => ({ steps: 0 }),
      step: (state) => {
        state.steps += 1;
      },
    }) {}
    class SlowEngine extends Game.Engine("SlowEngine", {
      simulation: Slow,
      view: () => ({
        render: (state) => drawn.push(state?.steps ?? null),
        dispose: () => {},
      }),
      input: () => ({ read: () => null, dispose: () => {} }),
    }) {}
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* SlowEngine;
          yield* engine.start(null, { seed: 1 });
          yield* Effect.forkScoped(engine.attach(element), {
            startImmediately: true,
          });
          // Ten seconds in a hidden tab: four steps, not five.
          ManualFrames.runFrameAt(frames, 10_000);
          // The quarter second was four whole steps, so 1/16 s later one more is owed.
          ManualFrames.runFrameAt(frames, 10_062.5);
        })
      ).pipe(
        Effect.provide(SlowEngine.layer),
        Effect.provide(Layer.succeed(Game.Frames, frames))
      )
    );
    expect(drawn).toStrictEqual([4, 5]);
  });
});

/** Attaches `engine`, detaches it at once, and gives how the attach ended. */
const attachAndDetach = (engine: CounterService) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(engine.attach(element), {
      startImmediately: true,
    });
    yield* Fiber.interrupt(fiber);
    return yield* Fiber.await(fiber);
  });

describe("attaching a game that throws", () => {
  it("disposes the view it made when the input can't be made, and can attach again", async () => {
    const cause = new Error("no pointer");
    const faults: Faults = { input: cause };
    let failed: Exit.Exit<never, unknown> | undefined;
    const log = await play(
      (engine, frames) =>
        Effect.gen(function* () {
          failed = yield* Effect.exit(engine.attach(element));
          expect(ManualFrames.waiting(frames)).toBe(false);
          delete faults.input;
          yield* attachAndDetach(engine);
        }),
      faults
    );
    expectFailure(
      failed,
      new Game.AttachError({ message: "no pointer", cause })
    );
    expect(log).toStrictEqual([
      "load sheet",
      "view game from sheet",
      "dispose view",
      "released",
      "load sheet",
      "view game from sheet",
      "input game",
      "dispose input",
      "dispose view",
      "released",
    ]);
  });

  it("disposes the view and detaches when the input's dispose throws, so it can attach again", async () => {
    const faults: Faults = { disposeInput: new Error("can't dispose") };
    let first: Exit.Exit<never, unknown> | undefined;
    const log = await play(
      (engine, frames) =>
        Effect.gen(function* () {
          first = yield* attachAndDetach(engine);
          expect(ManualFrames.waiting(frames)).toBe(false);
          delete faults.disposeInput;
          yield* attachAndDetach(engine);
        }),
      faults
    );
    // A throwing dispose is a bug in the game: detaching dies with it.
    expect(first !== undefined && Exit.hasDies(first)).toBe(true);
    expect(log).toStrictEqual([
      "load sheet",
      "view game from sheet",
      "input game",
      "dispose input",
      "dispose view",
      "released",
      "load sheet",
      "view game from sheet",
      "input game",
      "dispose input",
      "dispose view",
      "released",
    ]);
  });
});

describe("a game that throws while attached", () => {
  it("fails attach with GameCrashed when a step throws, asks for no more frames, and detaches", async () => {
    const bug = new Error("step bug");
    let exit: Exit.Exit<never, unknown> | undefined;
    const log = await play((engine, frames) =>
      Effect.gen(function* () {
        const fiber = yield* attached(engine);
        yield* engine.start({ from: 0, bug }, { seed: 1 });
        ManualFrames.runFrameAt(frames, 15.625);
        ManualFrames.runFrameAt(frames, 31.25);
        exit = yield* Fiber.await(fiber);
        expect(ManualFrames.waiting(frames)).toBe(false);
      })
    );
    expectFailure(
      exit,
      new Game.GameCrashed({ message: "step bug", cause: bug })
    );
    // The frame that threw is the last: nothing draws, and the view and input are disposed.
    expect(log).toStrictEqual([
      "load sheet",
      "view game from sheet",
      "input game",
      "dispose input",
      "dispose view",
      "released",
    ]);
  });

  it("fails attach with GameCrashed when a listener throws on an event of a frame, asks for no more frames, and detaches", async () => {
    const bug = new Error("listener bug");
    let exit: Exit.Exit<never, unknown> | undefined;
    const log = await play((engine, frames) =>
      Effect.gen(function* () {
        yield* engine.listen((event) => {
          // The first frame's sample, not the one `start` delivers.
          if (event.steps === 1) {
            throw bug;
          }
        });
        const fiber = yield* attached(engine);
        yield* engine.start({ from: 0 }, { seed: 1 });
        ManualFrames.runFrameAt(frames, 15.625);
        ManualFrames.runFrameAt(frames, 31.25);
        exit = yield* Fiber.await(fiber);
        expect(ManualFrames.waiting(frames)).toBe(false);
      })
    );
    expectFailure(
      exit,
      new Game.GameCrashed({ message: "listener bug", cause: bug })
    );
    // The step ran and its sample threw: that frame drew nothing.
    expect(log).toStrictEqual([
      "load sheet",
      "view game from sheet",
      "input game",
      "dispose input",
      "dispose view",
      "released",
    ]);
  });

  it("ends the run when a step throws, so attaching again draws no run and runs no step", async () => {
    const log = await play((engine, frames) =>
      Effect.gen(function* () {
        const crashing = yield* attached(engine);
        yield* engine.start(
          { from: 0, bug: new Error("step bug") },
          { seed: 1 }
        );
        ManualFrames.runFrameAt(frames, 15.625);
        yield* Fiber.await(crashing);
        yield* attached(engine);
        // No time has passed since the crash, and the step that threw was never counted as
        // run: a run left live would run it again here.
        ManualFrames.runFrameAt(frames, 15.625);
        expect(ManualFrames.waiting(frames)).toBe(true);
      })
    );
    expect(log).toStrictEqual([
      "load sheet",
      "view game from sheet",
      "input game",
      "dispose input",
      "dispose view",
      "released",
      "load sheet",
      "view game from sheet",
      "input game",
      "render null",
      "dispose input",
      "dispose view",
      "released",
    ]);
  });
});
