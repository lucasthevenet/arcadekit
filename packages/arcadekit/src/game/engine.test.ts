import { Context, Data, Effect, Exit, Fiber, Layer, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import { manualFrames } from "../runtime/testing";
import * as Game from "./browser";

// A game that counts its steps, declared the way a genre declares one, and an engine for it
// whose view and input log what the engine does with them. Frames run only when a test runs them.

class Counted extends Game.Event("Counted", { steps: Schema.Int }) {}
class Jump extends Game.Command("Jump", { by: Schema.Int }) {}

class Counter extends Game.Simulation("Counter", {
  // 1/64 s steps: frame times below are exact in floating point.
  stepSeconds: 1 / 64,
  input: Schema.Null,
  commands: [Jump],
  create: (config: { readonly from: number }, { seed }) => ({
    steps: config.from,
    seed,
  }),
  step: (state) => {
    state.steps += 1;
  },
  apply: {
    Jump: (state, command) => {
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
  input: (surface, { log }) => {
    log.push(`input ${surface.id}`);
    return { read: () => null, dispose: () => log.push("dispose input") };
  },
}) {}

const element = { id: "game" } as HTMLElement;

type CounterService = Context.Service.Shape<typeof CounterEngine>;

/**
 * Runs `scenario` with the engine, the frames it draws on and its log, then closes everything.
 * Returns the log.
 */
const play = async (
  scenario: (
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
        yield* scenario(engine, frames, log);
      })
    ).pipe(Effect.provide(layer))
  );
  return log;
};

/** Attaches the engine on a fiber of the caller's scope. It has asked for a frame on return. */
const attached = (engine: CounterService) =>
  Effect.forkScoped(engine.attach(element), { startImmediately: true });

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

  it("sends a command, which the next step applies", async () => {
    const log = await play((engine, frames) =>
      Effect.gen(function* () {
        yield* engine.start({ from: 0 }, { seed: 1 });
        yield* attached(engine);
        yield* engine.send(new Jump({ by: 100 }));
        frames.runFrameAt(15.625);
      })
    );
    expect(log).toContain("render 101");
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
    expect(exit).toStrictEqual(
      Exit.fail(new Game.AttachError({ message: "no WebGL", cause }))
    );
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
    expect(exit).toStrictEqual(
      Exit.fail(new Game.GameCrashed({ message: "lost context", cause }))
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

  it("dies when attached twice at once", async () => {
    let second: Exit.Exit<never, unknown> | undefined;
    await play((engine) =>
      Effect.gen(function* () {
        yield* attached(engine);
        second = yield* Effect.exit(engine.attach(element));
      })
    );
    expect(second !== undefined && Exit.hasDies(second)).toBe(true);
  });
});
