/**
 * Frames: where an attached engine gets its frames and their times, the engine's own frame clock.
 *
 * It times the engine's frames, which step by real time and then draw. It is not where stepping
 * adapters plug in: a test, a replay or a lockstep session calls a loop's `frame` instead, so it
 * can step without drawing. `animationFrames` is the browser's, and the `Frames` reference gives
 * it to an engine unless an app or a test provides another, such as `arcadekit/game/testing`'s
 * `ManualFrames`. Plain on purpose: a frame source is the host's callback, the bridge
 * that `Effect.callback` waits on.
 *
 * @since 0.7.0
 */
import { Context } from "effect";

/**
 * A source of frames: what time it is, and a request for a callback at the next frame.
 *
 * **When to use**
 *
 * To give an engine or a Co-op client frames of the app's own, as `Game.Frames`. A test uses
 * `arcadekit/game/testing`'s `ManualFrames`, and a browser `Game.animationFrames`.
 *
 * **Details**
 *
 * `now` is on the same timeline as the times `request` passes its callbacks. `request` calls its
 * callback once, at the next frame, and returns a function that cancels it.
 *
 * **Example** (Frames from a timer)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 *
 * let now = 0;
 * const pending: ((nowMs: number) => void)[] = [];
 * const frames: Game.FrameSource = {
 *   now: () => now,
 *   request: (callback) => {
 *     pending.push(callback);
 *     return () => pending.splice(pending.indexOf(callback), 1);
 *   },
 * };
 * let drawnAt = 0;
 * frames.request((nowMs) => {
 *   drawnAt = nowMs;
 * });
 * now = 16;
 * pending.shift()?.(now);
 * drawnAt; // => 16
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface FrameSource {
  /** Now, in ms, on the same timeline as the times `request` passes its callbacks. */
  readonly now: () => number;
  /** Calls `callback` once, at the next frame, with that frame's time in ms. Returns a function that cancels it. */
  readonly request: (callback: (nowMs: number) => void) => () => void;
}

/**
 * Frames from `requestAnimationFrame`, timed by `performance.now`: the browser's display refresh.
 *
 * **When to use**
 *
 * Nowhere by hand: it is `Game.Frames`' default, which an attached engine draws on.
 *
 * **Example** (The default frames)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 * import { Effect } from "effect";
 *
 * Effect.runSync(Game.Frames) === Game.animationFrames; // => true
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const animationFrames: FrameSource = {
  now: () => performance.now(),
  request: (callback) => {
    const handle = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(handle);
  },
};

/**
 * Where an attached engine gets its frames: `requestAnimationFrame` unless the app or a test
 * provides another frame source.
 *
 * **When to use**
 *
 * Provide it in a test, with `arcadekit/game/testing`'s `ManualFrames`, so an engine steps and
 * draws in Node with no `requestAnimationFrame`.
 *
 * **Details**
 *
 * A Co-op client (`arcadekit/net/browser`) draws on the same frames. An app rarely provides it:
 * the default is the browser's.
 *
 * **Example** (Frames a test provides)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 * import { ManualFrames } from "arcadekit/game/testing";
 * import { Effect, Layer } from "effect";
 *
 * const frames = ManualFrames.make();
 * const provided = Effect.runSync(Game.Frames.pipe(Effect.provide(Layer.succeed(Game.Frames, frames))));
 * provided === frames; // => true
 * ```
 *
 * @category references
 * @since 0.7.0
 */
export const Frames: Context.Reference<FrameSource> = Context.Reference(
  "arcadekit/game/Frames",
  { defaultValue: () => animationFrames }
);
