// The frame loop an attached engine runs (`makeGameEngine`'s `attach`), and how it crashes.

import { Data, Effect } from "effect";

import type { FrameSource } from "./frames";
import type { GameLoop } from "./loop";
import type { GameView } from "./presentation";
import type { InputSource } from "./simulation";

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
 * An attached engine's frames, until one throws: wait for the next frame from `frames`, then
 * step `loop` by the time since the last one and draw. A frame that throws also ends `loop`'s
 * run. Interrupted while it waits, it cancels the frame it asked for.
 *
 * Its Effects are made once per attach, not per frame: the frame's time and budget are kept in
 * place, every frame shares one frame callback, and the wait has no canceller of its own (the
 * loop cancels once, when it ends), which Effect would otherwise wrap anew each frame.
 */
export const frameLoop = <Config, State, Input, Event>(
  loop: GameLoop<Config, State, Input, Event>,
  frames: FrameSource,
  input: InputSource<Input>,
  view: GameView<State>
): Effect.Effect<never, GameCrashed> => {
  let resume: ((effect: Effect.Effect<void>) => void) | undefined;
  let cancel: (() => void) | undefined;
  let nowMs = 0;
  let lastMs = frames.now();
  const budget = { seconds: 0 };
  const onFrame = (timeMs: number) => {
    nowMs = timeMs;
    cancel = undefined;
    resume?.(Effect.void);
  };
  const nextFrame: Effect.Effect<void> = Effect.callback((resumeLoop) => {
    resume = resumeLoop;
    cancel = frames.request(onFrame);
  });
  // The frame's whole work in one Effect, so the fiber can't yield in the middle of it, and a
  // throw ends the loop before it asks for another frame.
  const frame = Effect.try({
    try: () => {
      // requestAnimationFrame passes the time its frame began, which can be before attach.
      budget.seconds = Math.max(0, nowMs - lastMs) / 1000;
      lastMs = nowMs;
      loop.frame(input, budget, nowMs);
      view.render(loop.state, nowMs / 1000);
    },
    catch: (cause) => {
      // A crash ends the run: a step that threw left its state half-changed and is still owed
      // on the clock, so attaching again would run it again on its first frame.
      loop.stop();
      return new GameCrashed({ message: messageOf(cause), cause });
    },
  });
  // Waiting for the frame is the loop's only yield, so `forever` needn't add one.
  return Effect.forever(Effect.andThen(nextFrame, frame), {
    disableYield: true,
  }).pipe(
    // Interrupted, it was waiting for a frame: cancel it. After a crash, none is waiting.
    Effect.ensuring(Effect.sync(() => cancel?.()))
  );
};
