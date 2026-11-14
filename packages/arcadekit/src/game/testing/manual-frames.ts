/**
 * Manual frames: a frame source a test runs by hand, so an engine or a Co-op client steps and
 * draws in Node with no `requestAnimationFrame`.
 *
 * No frame runs until the test runs it, at a time it chooses, and the frame runs inside that
 * call: what an attached engine does on it has happened when `runFrameAt` returns. It is a
 * `Game.FrameSource`, so a test provides it as `Game.Frames`. Plain on purpose: it is
 * the host's callback, run by a test.
 *
 * @since 0.7.0
 */
import { Inspectable, Pipeable, Predicate } from "effect";
import type { Types } from "effect";
import { dual } from "effect/Function";

import type { FrameSource } from "../frames";

const TypeId = "~arcadekit/game/testing/ManualFrames";

/**
 * A frame source a test drives: `now` and `request`, as an engine calls them, and a frame that
 * runs only when the test runs it.
 *
 * **When to use**
 *
 * In a test of anything that draws on frames: provide it as `Game.Frames`, then run each frame
 * with `ManualFrames.runFrameAt`.
 *
 * **Details**
 *
 * `now` starts at 0, and moves only when a frame runs. A frame source holds one request at a
 * time, as an engine makes one: a second request replaces the first.
 *
 * **Example** (A frame a test runs)
 *
 * ```ts
 * import { ManualFrames } from "arcadekit/game/testing";
 *
 * const frames = ManualFrames.make();
 * const drawn: number[] = [];
 * frames.request((nowMs) => {
 *   drawn.push(nowMs);
 * });
 * ManualFrames.runFrameAt(frames, 16);
 * drawn; // => [16]
 * frames.now(); // => 16
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface ManualFrames
  extends FrameSource, Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
}

/** What the module's functions keep, which no caller reads. */
type Internal = Types.Mutable<ManualFrames> & {
  /** The time `now` gives: the last frame's. */
  nowMs: number;
  /** The callback of the frame asked for and not yet run or cancelled. */
  pending: ((nowMs: number) => void) | null;
};

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: Internal) {
    return {
      _id: "ManualFrames",
      nowMs: this.nowMs,
      waiting: this.pending !== null,
    };
  },
};

/**
 * Checks whether a value is a manual frame source.
 *
 * **When to use**
 *
 * Narrow an unknown frame source before running its frames by hand.
 *
 * **Example** (Recognising manual frames)
 *
 * ```ts
 * import { ManualFrames } from "arcadekit/game/testing";
 *
 * ManualFrames.isManualFrames(ManualFrames.make()); // => true
 * ManualFrames.isManualFrames({ now: () => 0, request: () => () => {} }); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isManualFrames = (value: unknown): value is ManualFrames =>
  Predicate.hasProperty(value, TypeId);

/**
 * Makes a frame source with no frame asked for, whose `now` is 0.
 *
 * **When to use**
 *
 * Once per test that drives an engine or a Co-op client, provided as `Game.Frames`.
 *
 * **Example** (Frames to provide)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 * import { ManualFrames } from "arcadekit/game/testing";
 * import { Layer } from "effect";
 *
 * const frames = ManualFrames.make();
 * const provided = Layer.succeed(Game.Frames, frames);
 * frames.now(); // => 0
 * ManualFrames.waiting(frames); // => false
 * Layer.isLayer(provided); // => true
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = (): ManualFrames => {
  const self = Object.create(Proto) as Internal;
  self.nowMs = 0;
  self.pending = null;
  self.now = () => self.nowMs;
  self.request = (callback) => {
    self.pending = callback;
    return () => {
      if (self.pending === callback) {
        self.pending = null;
      }
    };
  };
  return self;
};

/**
 * Whether a frame was asked for and has not run or been cancelled.
 *
 * **When to use**
 *
 * To check that an engine is attached and drawing, and that it asks for no frame after a detach
 * or a crash.
 *
 * **Example** (A frame asked for, then cancelled)
 *
 * ```ts
 * import { ManualFrames } from "arcadekit/game/testing";
 *
 * const frames = ManualFrames.make();
 * const cancel = frames.request(() => {});
 * ManualFrames.waiting(frames); // => true
 * cancel();
 * ManualFrames.waiting(frames); // => false
 * ```
 *
 * @category getters
 * @since 0.7.0
 */
export const waiting = (self: ManualFrames): boolean =>
  (self as Internal).pending !== null;

/**
 * Moves `now` to `nowMs`, then runs the frame asked for, if any, at that time, inside this call.
 *
 * **When to use**
 *
 * In a test, once per frame it wants an engine to step and draw: what the frame does has
 * happened when this returns.
 *
 * **Details**
 *
 * The frame's callback is forgotten before it runs, so a callback that asks for the next frame,
 * as an engine's does, is waiting when this returns. With no frame asked for, only `now` moves.
 *
 * **Example** (Two frames, one after the other)
 *
 * ```ts
 * import { ManualFrames } from "arcadekit/game/testing";
 *
 * const frames = ManualFrames.make();
 * const drawn: number[] = [];
 * const draw = (nowMs: number) => {
 *   drawn.push(nowMs);
 *   frames.request(draw);
 * };
 * frames.request(draw);
 * ManualFrames.runFrameAt(frames, 16);
 * frames.pipe(ManualFrames.runFrameAt(33));
 * drawn; // => [16, 33]
 * ManualFrames.waiting(frames); // => true
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const runFrameAt: {
  (nowMs: number): (self: ManualFrames) => void;
  (self: ManualFrames, nowMs: number): void;
} = dual(2, (self: ManualFrames, nowMs: number): void => {
  const frames = self as Internal;
  frames.nowMs = nowMs;
  const callback = frames.pending;
  frames.pending = null;
  callback?.(nowMs);
});
