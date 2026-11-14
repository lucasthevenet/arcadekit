/**
 * Tweens: values a view computes each frame from when something started.
 *
 * No object holds a tween, nothing calls back, and a view writes nothing: it keeps when a slide
 * or a flash started, takes `progress` toward its end, eases it and draws. Every ease here is a
 * polynomial, so a step may call it too.
 *
 * @since 0.7.0
 */
import { dual } from "effect/Function";

import { clamp } from "./exact-math";

/**
 * How far `now` is from `startedAt` toward `startedAt + duration`, from 0 to 1.
 *
 * **When to use**
 *
 * In a view, each frame, for anything that moves or fades over a set time from when it started:
 * then ease it and draw.
 *
 * **Details**
 *
 * It is 1 once `now - startedAt >= duration`: a `startedAt` of `-Infinity` is done, and a
 * `duration` of 0 never divides. It is 0 before `startedAt`.
 *
 * **Example** (Sliding a box over a quarter second)
 *
 * ```ts
 * import { ExactMath, Tween } from "arcadekit/core";
 *
 * const slide = { startedAt: 2, from: 0, to: 1 };
 * const t = Tween.progress(2.125, slide.startedAt, 0.25);
 * t; // => 0.5
 * ExactMath.lerp(slide.from, slide.to, Tween.easeOut(t)); // => 0.75
 * Tween.progress(3, slide.startedAt, 0.25); // => 1
 * ```
 *
 * @category math
 * @since 0.7.0
 */
export const progress: {
  (startedAt: number, duration: number): (now: number) => number;
  (now: number, startedAt: number, duration: number): number;
} = dual(3, (now: number, startedAt: number, duration: number): number => {
  const elapsed = now - startedAt;
  if (elapsed >= duration) {
    return 1;
  }
  return elapsed > 0 ? elapsed / duration : 0;
});

/**
 * Starts slow: `t * t`.
 *
 * **When to use**
 *
 * For something that gathers speed, such as a thing falling into a hole.
 *
 * **Example** (Easing in)
 *
 * ```ts
 * import { Tween } from "arcadekit/core";
 *
 * Tween.easeIn(0.5); // => 0.25
 * Tween.easeIn(1); // => 1
 * ```
 *
 * @category math
 * @since 0.7.0
 */
export const easeIn = (t: number): number => t * t;

/**
 * Ends slow: `t * (2 - t)`.
 *
 * **When to use**
 *
 * For something that settles where it is going, such as a box sliding into its cell.
 *
 * **Example** (Easing out)
 *
 * ```ts
 * import { Tween } from "arcadekit/core";
 *
 * Tween.easeOut(0.5); // => 0.75
 * Tween.easeOut(1); // => 1
 * ```
 *
 * @category math
 * @since 0.7.0
 */
export const easeOut = (t: number): number => t * (2 - t);

/**
 * Ends slower: `1 - (1 - t) * (1 - t) * (1 - t)`.
 *
 * **When to use**
 *
 * For a settle that is quick at first and long at the end, such as a camera catching up.
 *
 * **Example** (Easing out harder)
 *
 * ```ts
 * import { Tween } from "arcadekit/core";
 *
 * Tween.easeOutCubic(0.5); // => 0.875
 * Tween.easeOutCubic(1); // => 1
 * ```
 *
 * @category math
 * @since 0.7.0
 */
export const easeOutCubic = (t: number): number =>
  1 - (1 - t) * (1 - t) * (1 - t);

/**
 * Starts and ends slow: `c * c * (3 - 2 * c)`, where `c` is `t` clamped to `[0, 1]`.
 *
 * **When to use**
 *
 * For a fade or a move that should neither start nor stop abruptly.
 *
 * **Details**
 *
 * It is the only ease here that clamps: the others take a progress, which is in `[0, 1]`
 * already.
 *
 * **Example** (Fading a banner in and out)
 *
 * ```ts
 * import { Tween } from "arcadekit/core";
 *
 * Tween.smoothstep(0.5); // => 0.5
 * Tween.smoothstep(0.25); // => 0.15625
 * Tween.smoothstep(2); // => 1
 * ```
 *
 * @category math
 * @since 0.7.0
 */
export const smoothstep = (t: number): number => {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
};
