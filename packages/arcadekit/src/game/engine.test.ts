import {
  Context,
  Data,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
} from "effect";
import type { Scope } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import * as Game from "./browser";
import { manualFrames } from "./testing";

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
    frames: ReturnType<typeof manualFrames>,
    log: string[]
  ) => Effect.Effect<void, never, Scope.Scope>,
  faults: Faults = {}
) => {
  const frames = manualFrames();
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
  expect(exit).toStrictEqual(Exit.fail(expected));
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
  frames: ReturnType<typeof manualFrames>,
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
        frames.runFrameAt(15.625);
        frames.runFrameAt(31.25);
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
        Effect.provide(Layer.succeed(Game.Frames, manualFrames()))
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
            frames.runFrameAt(15.625);
          })
        );
        yield* attached(engine);
        // The listener's scope has closed: this step's sample reaches no one.
        frames.runFrameAt(31.25);
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
        frames.runFrameAt(15.625);
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
        frames.runFrameAt(15.625);
        yield* Fiber.await(sender);
        frames.runFrameAt(31.25);
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
          frames.runFrameAt(15.625);
          yield* Fiber.await(crashing);
          yield* Fiber.await(sender);
          delete faults.read;
          yield* attached(engine);
          frames.runFrameAt(31.25);
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
        frames.runFrameAt(15.625);
        exit = yield* Fiber.await(sent);
      })
    );
    expect(exit).toStrictEqual(Exit.fail(new TooFar({ limit: JUMP_LIMIT })));
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
    expect(exits).toStrictEqual([
      Exit.fail(new Game.CommandDropped({ command: "Jump", reason: "noRun" })),
      Exit.fail(
        new Game.CommandDropped({ command: "Jump", reason: "runEnded" })
      ),
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
        frames.runFrameAt(15.625);
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
        frames.runFrameAt(15.625);
        yield* engine.setPaused(false);
        frames.runFrameAt(31.25);
        yield* engine.stop;
        frames.runFrameAt(46.875);
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
          frames.runFrameAt(15.625);
        }),
      faults
    );
    expect(exits).toStrictEqual([
      Exit.fail(new SheetMissing({ message: "no sheet" })),
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
          frames.runFrameAt(15.625);
          exit = yield* Fiber.await(fiber);
          expect(frames.waiting()).toBe(false);
          delete faults.render;
          yield* attached(engine);
          frames.runFrameAt(31.25);
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
        frames.runFrameAt(15.625);
      })
    );
    expect(second !== undefined && Exit.hasDies(second)).toBe(true);
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

describe("an attached engine's frames", () => {
  it("draws until its scope closes, then cancels the frame it asked for: a later frame draws nothing", async () => {
    const frames = manualFrames();
    const log = await playTimed(frames, () =>
      Effect.sync(() => {
        frames.runFrameAt(15.625);
        // Each frame asks for the next one.
        expect(frames.waiting()).toBe(true);
      })
    );
    // Closing the scope cancelled that request, so a later frame draws nothing.
    expect(frames.waiting()).toBe(false);
    frames.runFrameAt(31.25);
    expect(log).toStrictEqual([
      "view game",
      "input game",
      "render null",
      "dispose input",
      "dispose view",
    ]);
  });

  it("ends the run on stop: the view then draws no state, and nothing steps or samples", async () => {
    const frames = manualFrames();
    const log = await playTimed(frames, (engine) =>
      Effect.gen(function* () {
        yield* engine.start(null, { seed: 1 });
        // 1/64 s after attach: one step.
        frames.runFrameAt(15.625);
        yield* engine.stop;
        frames.runFrameAt(31.25);
        frames.runFrameAt(46.875);
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
    const frames = manualFrames();
    const log = await playTimed(frames, (engine) =>
      Effect.gen(function* () {
        yield* engine.start(null, { seed: 1 });
        frames.runFrameAt(15.625);
        yield* engine.setPaused(true);
        frames.runFrameAt(31.25);
        frames.runFrameAt(46.875);
        yield* engine.setPaused(false);
        frames.runFrameAt(62.5);
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
    const frames = manualFrames();
    const log = await playTimed(frames, (engine) =>
      Effect.gen(function* () {
        yield* engine.start(null, { seed: 1 });
        frames.runFrameAt(15.625);
        yield* engine.setPaused(true);
        yield* engine.start(null, { seed: 2 });
        frames.runFrameAt(31.25);
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
    const frames = manualFrames();
    // Attach at 100 ms. requestAnimationFrame passes the time its frame began, which can be
    // before then.
    frames.runFrameAt(100);
    const log = await playTimed(frames, (engine) =>
      Effect.gen(function* () {
        yield* engine.start(null, { seed: 1 });
        frames.runFrameAt(50);
        frames.runFrameAt(65.625);
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
        frames.runFrameAt(10_000);
        frames.runFrameAt(10_015.625);
      })
    );
    expect(log.filter((line) => line.startsWith("render"))).toStrictEqual([
      "render 5",
      "render 6",
    ]);
  });

  it("counts at most a quarter of a second of a long gap between frames", async () => {
    const frames = manualFrames();
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
          frames.runFrameAt(10_000);
          // The quarter second was four whole steps, so 1/16 s later one more is owed.
          frames.runFrameAt(10_062.5);
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
          expect(frames.waiting()).toBe(false);
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
          expect(frames.waiting()).toBe(false);
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
        frames.runFrameAt(15.625);
        frames.runFrameAt(31.25);
        exit = yield* Fiber.await(fiber);
        expect(frames.waiting()).toBe(false);
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
        frames.runFrameAt(15.625);
        frames.runFrameAt(31.25);
        exit = yield* Fiber.await(fiber);
        expect(frames.waiting()).toBe(false);
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
        frames.runFrameAt(15.625);
        yield* Fiber.await(crashing);
        yield* attached(engine);
        // No time has passed since the crash, and the step that threw was never counted as
        // run: a run left live would run it again here.
        frames.runFrameAt(15.625);
        expect(frames.waiting()).toBe(true);
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
