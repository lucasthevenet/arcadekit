import { Effect } from "effect";

import { GameCrashed } from "../../runtime/browser";
import type { FrameSource } from "../../runtime/browser";

// The co-op client's frames while it is attached: what `frameLoop` in arcadekit/runtime is to
// an attached engine, for a client that steps on its own ticker and only ticks and draws here.

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Calls `frame(nowMs)` on every frame of `frames` until one throws, then fails with GameCrashed
 * and asks for no other frame. Interrupted while it waits, it cancels the frame it asked for.
 *
 * Its Effects are made once per attach, not per frame: one wait shared by every frame, and one
 * `Effect.try` for the frame's whole work, which asks for the next frame only after the frame
 * has drawn.
 */
export const coopFrameLoop = (
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
