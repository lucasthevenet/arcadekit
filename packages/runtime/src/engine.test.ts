import { Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { AttachError, GameCrashed, makeGameEngine } from "./browser";
import type { GameDefinition, GameEngine } from "./browser";
import { manualFrames } from "./testing";

interface Counter {
  steps: number;
}

const element = { id: "game" } as HTMLElement;

/**
 * A game that counts its steps and logs what the runtime does with it: each view and input
 * source it creates and disposes, each step, each frame drawn.
 */
const recordingGame = (
  log: string[]
): GameDefinition<null, Counter, null, string> => ({
  // 1/64 s steps: frame times below are exact in floating point.
  stepSeconds: 1 / 64,
  create: () => ({ steps: 0 }),
  step: (state) => {
    state.steps += 1;
    log.push("step");
  },
  drainEvents: () => [],
  // Every 10 ms. Frames below are further apart, so each one is due a sample.
  sample: { everyMs: 10, read: (state) => `sample ${state.steps}` },
  createInput: (surface) => {
    log.push(`createInput ${surface.id}`);
    return { read: () => null, dispose: () => log.push("dispose input") };
  },
  createView: (container) => {
    log.push(`createView ${container.id}`);
    return {
      render: (state) => log.push(`render ${state?.steps ?? "null"}`),
      dispose: () => log.push("dispose view"),
    };
  },
});

/**
 * Attaches `engine` to `element` on a fiber of its own, scoped to the caller. It starts at
 * once, so it has made its view and asked for a frame by the time this returns.
 */
const attached = (engine: GameEngine<null, Counter, string>) =>
  Effect.forkScoped(engine.attach(element), { startImmediately: true });

/**
 * Attaches an engine for the recording game to `element`, logs its events too, runs
 * `scenario`, then closes the scope. The log keeps recording after that. Frames run only when
 * the test runs them on `frames`.
 */
const play = async (
  frames: ReturnType<typeof manualFrames>,
  scenario: (engine: GameEngine<null, Counter, string>) => Effect.Effect<void>
) => {
  const log: string[] = [];
  const engine = makeGameEngine(recordingGame(log), { frames });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* engine.listen((event) => log.push(event));
        yield* attached(engine);
        yield* scenario(engine);
      })
    )
  );
  return log;
};

/** Attaches `engine`, detaches it at once, and returns how attaching ended. */
const attachAndDetach = (engine: GameEngine<null, Counter, string>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(engine.attach(element), {
        startImmediately: true,
      });
      yield* Fiber.interrupt(fiber);
      return yield* Fiber.await(fiber);
    })
  );

describe(makeGameEngine, () => {
  it("draws into the element until the scope closes, then cancels the frame loop and disposes the view and input source", async () => {
    const frames = manualFrames();
    const log = await play(frames, () =>
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
      "createView game",
      "createInput game",
      "render null",
      "dispose input",
      "dispose view",
    ]);
  });

  it("ends the run on stop: the view then draws a null state and no more steps run", async () => {
    const frames = manualFrames();
    const log = await play(frames, (engine) =>
      Effect.gen(function* () {
        yield* engine.start(null);
        // 1/64 s after attach: one step.
        frames.runFrameAt(15.625);
        yield* engine.stop;
        frames.runFrameAt(31.25);
        frames.runFrameAt(46.875);
      })
    );
    expect(log).toStrictEqual([
      "createView game",
      "createInput game",
      "sample 0",
      "step",
      "sample 1",
      "render 1",
      // Stopped: the view draws a null state. Nothing steps or samples.
      "render null",
      "render null",
      "dispose input",
      "dispose view",
    ]);
  });

  it("runs no steps or timed samples while paused, keeps drawing, and resumes when unpaused", async () => {
    const frames = manualFrames();
    const log = await play(frames, (engine) =>
      Effect.gen(function* () {
        yield* engine.start(null);
        frames.runFrameAt(15.625);
        yield* engine.setPaused(true);
        frames.runFrameAt(31.25);
        frames.runFrameAt(46.875);
        yield* engine.setPaused(false);
        frames.runFrameAt(62.5);
      })
    );
    expect(log).toStrictEqual([
      "createView game",
      "createInput game",
      "sample 0",
      "step",
      "sample 1",
      "render 1",
      // Paused: the view still draws the run. Nothing steps or samples.
      "render 1",
      "render 1",
      // Unpaused: one step for the 1/64 s since the last frame. Paused time doesn't count.
      "step",
      "sample 2",
      "render 2",
      "dispose input",
      "dispose view",
    ]);
  });

  it("counts a first frame timed before attach as no time, so the next frame still steps", async () => {
    const frames = manualFrames();
    // Attach at 100 ms. requestAnimationFrame passes the time its frame began, which can be
    // before then.
    frames.runFrameAt(100);
    const log = await play(frames, (engine) =>
      Effect.gen(function* () {
        yield* engine.start(null);
        frames.runFrameAt(50);
        frames.runFrameAt(65.625);
      })
    );
    expect(log).toStrictEqual([
      "createView game",
      "createInput game",
      "sample 0",
      "render 0",
      // 1/64 s after the first frame: one step. No sample is due: these frames are timed
      // within 10 ms of the start's sample at 100 ms.
      "step",
      "render 1",
      "dispose input",
      "dispose view",
    ]);
  });

  it("dies when attached again while attached, a programming error, and keeps drawing", async () => {
    const frames = manualFrames();
    let second: Exit.Exit<never, unknown> | undefined;
    const log = await play(frames, (engine) =>
      Effect.gen(function* () {
        second = yield* Effect.exit(engine.attach(element));
        frames.runFrameAt(15.625);
      })
    );
    expect(second !== undefined && Exit.hasDies(second)).toBe(true);
    expect(log).toStrictEqual([
      "createView game",
      "createInput game",
      "render null",
      "dispose input",
      "dispose view",
    ]);
  });
});

/** The recording game with some of its parts replaced, such as one that throws. */
const withParts = (
  log: string[],
  parts: Partial<GameDefinition<null, Counter, null, string>>
): GameDefinition<null, Counter, null, string> => ({
  ...recordingGame(log),
  ...parts,
});

describe("attaching a game that throws", () => {
  it("fails with an AttachError carrying the cause when createView throws, as Three.js does without WebGL", async () => {
    const log: string[] = [];
    const noWebGl = new Error("no WebGL");
    const engine = makeGameEngine(
      withParts(log, {
        createView: () => {
          throw noWebGl;
        },
      }),
      { frames: manualFrames() }
    );
    const error = await Effect.runPromise(Effect.flip(engine.attach(element)));
    expect(error).toBeInstanceOf(AttachError);
    expect(error).toMatchObject({
      _tag: "AttachError",
      message: "no WebGL",
      cause: noWebGl,
    });
  });

  it("disposes the view it made when createInput throws, and can attach again", async () => {
    const log: string[] = [];
    let inputs = 0;
    const base = recordingGame(log);
    const frames = manualFrames();
    const engine = makeGameEngine(
      withParts(log, {
        createInput: (surface) => {
          inputs += 1;
          if (inputs === 1) {
            throw new Error("no input");
          }
          return base.createInput(surface);
        },
      }),
      { frames }
    );
    const failed = await Effect.runPromiseExit(engine.attach(element));
    expect(Exit.isFailure(failed)).toBe(true);
    expect(frames.waiting()).toBe(false);
    await attachAndDetach(engine);
    expect(log).toStrictEqual([
      "createView game",
      "dispose view",
      "createView game",
      "createInput game",
      "dispose input",
      "dispose view",
    ]);
  });

  it("disposes the view and detaches when the input's dispose throws, so it can attach again", async () => {
    const log: string[] = [];
    let inputs = 0;
    const base = recordingGame(log);
    const frames = manualFrames();
    const engine = makeGameEngine(
      withParts(log, {
        createInput: (surface) => {
          inputs += 1;
          const input = base.createInput(surface);
          return inputs === 1
            ? {
                read: input.read,
                dispose: () => {
                  input.dispose();
                  throw new Error("can't dispose");
                },
              }
            : input;
        },
      }),
      { frames }
    );
    const first = await attachAndDetach(engine);
    // A throwing dispose is a bug in the game: detaching dies with it.
    expect(Exit.hasDies(first)).toBe(true);
    expect(frames.waiting()).toBe(false);
    await attachAndDetach(engine);
    expect(log).toStrictEqual([
      "createView game",
      "createInput game",
      "dispose input",
      "dispose view",
      "createView game",
      "createInput game",
      "dispose input",
      "dispose view",
    ]);
  });
});

/**
 * Attaches an engine for the recording game with `parts` replaced, starts a run, and runs
 * frames at 15.625 ms and 31.25 ms. `onEvent`, if given, listens to the engine's events from
 * before the start. Returns what attaching failed with, whether a frame was still requested,
 * the log, and the engine and its frames.
 */
const crash = async (
  parts: (
    log: string[]
  ) => Partial<GameDefinition<null, Counter, null, string>>,
  onEvent?: (event: string) => void
) => {
  const log: string[] = [];
  const frames = manualFrames();
  const engine = makeGameEngine(withParts(log, parts(log)), { frames });
  const error = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        if (onEvent !== undefined) {
          yield* engine.listen(onEvent);
        }
        const fiber = yield* Effect.forkChild(engine.attach(element), {
          startImmediately: true,
        });
        yield* engine.start(null);
        frames.runFrameAt(15.625);
        frames.runFrameAt(31.25);
        return yield* Effect.flip(Fiber.join(fiber));
      })
    )
  );
  return { error, waiting: frames.waiting(), log, engine, frames };
};

describe("a game that throws while attached", () => {
  it("fails attach with GameCrashed when a step throws, asks for no more frames, and detaches", async () => {
    const bug = new Error("step bug");
    const { error, waiting, log } = await crash(() => ({
      step: () => {
        throw bug;
      },
    }));
    expect(error).toBeInstanceOf(GameCrashed);
    expect(error).toMatchObject({
      _tag: "GameCrashed",
      message: "step bug",
      cause: bug,
    });
    expect(waiting).toBe(false);
    // The frame that threw is the last: nothing draws, and the view and input are disposed.
    expect(log).toStrictEqual([
      "createView game",
      "createInput game",
      "dispose input",
      "dispose view",
    ]);
  });

  it("fails attach with GameCrashed when render throws, asks for no more frames, and detaches", async () => {
    const bug = new Error("render bug");
    const { error, waiting, log } = await crash((record) => ({
      createView: (container) => {
        record.push(`createView ${container.id}`);
        return {
          render: () => {
            throw bug;
          },
          dispose: () => record.push("dispose view"),
        };
      },
    }));
    expect(error).toMatchObject({
      _tag: "GameCrashed",
      message: "render bug",
      cause: bug,
    });
    expect(waiting).toBe(false);
    expect(log).toStrictEqual([
      "createView game",
      "createInput game",
      "step",
      "dispose input",
      "dispose view",
    ]);
  });

  it("fails attach with GameCrashed when a listener throws on an event of a frame, asks for no more frames, and detaches", async () => {
    const bug = new Error("listener bug");
    const { error, waiting, log } = await crash(
      () => ({}),
      (event) => {
        // The first frame's sample, not the one `start` delivers.
        if (event === "sample 1") {
          throw bug;
        }
      }
    );
    expect(error).toMatchObject({
      _tag: "GameCrashed",
      message: "listener bug",
      cause: bug,
    });
    expect(waiting).toBe(false);
    expect(log).toStrictEqual([
      "createView game",
      "createInput game",
      "step",
      "dispose input",
      "dispose view",
    ]);
  });

  it("ends the run when a frame throws, so attaching again draws no run and runs no step", async () => {
    // A step that always throws, as a bug that repeats does.
    const { engine, frames, log } = await crash(() => ({
      step: () => {
        throw new Error("step bug");
      },
    }));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* attached(engine);
          // No time has passed since the crash, and the step that threw was never counted
          // as run: a run left live would run it again here.
          frames.runFrameAt(31.25);
          expect(frames.waiting()).toBe(true);
        })
      )
    );
    expect(log).toStrictEqual([
      "createView game",
      "createInput game",
      "dispose input",
      "dispose view",
      "createView game",
      "createInput game",
      "render null",
      "dispose input",
      "dispose view",
    ]);
  });

  it("can attach again after a crash", async () => {
    const log: string[] = [];
    let renders = 0;
    const frames = manualFrames();
    const base = recordingGame(log);
    const engine = makeGameEngine(
      withParts(log, {
        createView: (container) => {
          const view = base.createView(container);
          return {
            render: (state, time) => {
              renders += 1;
              if (renders === 1) {
                throw new Error("first frame only");
              }
              view.render(state, time);
            },
            dispose: view.dispose,
          };
        },
      }),
      { frames }
    );
    const crashed = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(engine.attach(element), {
          startImmediately: true,
        });
        frames.runFrameAt(15.625);
        return yield* Fiber.join(fiber);
      })
    );
    expect(Exit.isFailure(crashed)).toBe(true);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* attached(engine);
          frames.runFrameAt(31.25);
        })
      )
    );
    expect(log).toStrictEqual([
      "createView game",
      "createInput game",
      "dispose input",
      "dispose view",
      "createView game",
      "createInput game",
      "render null",
      "dispose input",
      "dispose view",
    ]);
  });
});
