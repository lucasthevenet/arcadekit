// Frames: the loop an attached engine or client draws on, and how it crashes.

import { Data, Effect } from "effect";

import type { FrameSource } from "./frames";
import type { FrameBudget } from "./game-loop";
import type { StepInput } from "./step-input";
import type { GameView } from "./view";

// Named so the type files can be made one file at a time (isolatedDeclarations).
const GameCrashedBase: ReturnType<typeof Data.TaggedError<"GameCrashed">> =
  Data.TaggedError("GameCrashed");

/**
 * An attached engine whose frame threw: a step, a render, or a listener of its events. That
 * frame was its last: the run ended, and the engine detached. `cause` is what was thrown. It is
 * a bug in the game, but the app reports it like an `AttachError` instead of leaving a frozen
 * viewport.
 */
export class GameCrashed extends GameCrashedBase<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/** The message of what was thrown, for an error that carries it as its `cause`. */
export const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Calls `frame(nowMs)` on every frame of `frames` until one throws, then fails with
 * `GameCrashed` and asks for no other frame. Interrupted while it waits, it cancels the frame it
 * asked for. An engine's and the Co-op client's frames run on it, and an app can draw anything
 * else on animation frames with it, such as a demo scene outside a run.
 *
 * Its Effects are made once, not per frame: one wait shared by every frame, with no canceller of
 * its own (the loop cancels once, when it ends), and one `Effect.try` for the frame's whole
 * work, so the fiber can't yield in the middle of it and a throw ends the loop before it asks
 * for another frame.
 */
export const frameLoop = (
  frames: FrameSource,
  frame: (nowMs: number) => void
): Effect.Effect<never, GameCrashed> => {
  let resume: ((effect: Effect.Effect<void>) => void) | undefined;
  let cancel: (() => void) | undefined;
  let nowMs = 0;
  const onFrame = (timeMs: number) => {
    nowMs = timeMs;
    cancel = undefined;
    resume?.(Effect.void);
  };
  const nextFrame: Effect.Effect<void> = Effect.callback((resumeLoop) => {
    resume = resumeLoop;
    cancel = frames.request(onFrame);
  });
  const drawn = Effect.try({
    try: () => frame(nowMs),
    catch: (cause) => new GameCrashed({ message: messageOf(cause), cause }),
  });
  // Waiting for the frame is the loop's only yield, so `forever` needn't add one.
  return Effect.forever(Effect.andThen(nextFrame, drawn), {
    disableYield: true,
  }).pipe(
    // Interrupted, it was waiting for a frame: cancel it. After a crash, none is waiting.
    Effect.ensuring(Effect.sync(() => cancel?.()))
  );
};

/** What an attached engine's frames step: the part of `Game.Loop` they call. */
export interface SteppedLoop<State, Input> {
  readonly state: State | null;
  readonly frame: (
    input: StepInput<Input>,
    budget: FrameBudget,
    nowMs: number
  ) => number;
  readonly stop: () => void;
}

/**
 * An attached engine's frames, until one throws: step `loop` by the time since the last frame,
 * then draw. A frame that throws also ends `loop`'s run: a step that threw left its state
 * half-changed and is still owed on the clock, so attaching again would run it again on its
 * first frame.
 */
export const steppedFrames = <State, Input>(
  loop: SteppedLoop<State, Input>,
  frames: FrameSource,
  input: StepInput<Input>,
  view: GameView<State>
): Effect.Effect<never, GameCrashed> => {
  let lastMs = frames.now();
  // Kept in place, so a frame allocates nothing of its own.
  const budget = { seconds: 0 };
  return frameLoop(frames, (nowMs) => {
    try {
      // requestAnimationFrame passes the time its frame began, which can be before attach.
      budget.seconds = Math.max(0, nowMs - lastMs) / 1000;
      lastMs = nowMs;
      loop.frame(input, budget, nowMs);
      view.render(loop.state, nowMs / 1000);
    } catch (error) {
      loop.stop();
      throw error;
    }
  });
};
