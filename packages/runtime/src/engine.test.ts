import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { AttachError, makeGameEngine } from "./browser";
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
        yield* engine.attach(element);
        yield* scenario(engine);
      })
    )
  );
  return log;
};

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
    const error = await Effect.runPromise(
      Effect.scoped(Effect.flip(engine.attach(element)))
    );
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
    const failed = await Effect.runPromiseExit(
      Effect.scoped(engine.attach(element))
    );
    expect(Exit.isFailure(failed)).toBe(true);
    expect(frames.waiting()).toBe(false);
    await Effect.runPromise(Effect.scoped(engine.attach(element)));
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
    const first = await Effect.runPromiseExit(
      Effect.scoped(engine.attach(element))
    );
    // A throwing dispose is a bug in the game: the scope's close dies with it.
    expect(Exit.hasDies(first)).toBe(true);
    expect(frames.waiting()).toBe(false);
    await Effect.runPromise(Effect.scoped(engine.attach(element)));
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
