import { clamp } from "./math";

// Tweens as plain functions of time. A tween is a value a view computes each frame from when it
// started: no object holds it, nothing calls back, and a view writes nothing. Every ease here is
// a polynomial, so a step may call it too (ADR-0011).

/**
 * How far `now` is from `startedAt` toward `startedAt + duration`, from 0 to 1.
 *
 * 1 once `now - startedAt >= duration`: a `startedAt` of `-Infinity` is done, and a `duration` of
 * 0 never divides. 0 before `startedAt`.
 */
export const progress = (
  now: number,
  startedAt: number,
  duration: number
): number => {
  const elapsed = now - startedAt;
  if (elapsed >= duration) {
    return 1;
  }
  return elapsed > 0 ? elapsed / duration : 0;
};

/** Starts slow: `t * t`. */
export const easeIn = (t: number): number => t * t;

/** Ends slow: `t * (2 - t)`. */
export const easeOut = (t: number): number => t * (2 - t);

/** Ends slower: `1 - (1 - t) * (1 - t) * (1 - t)`. */
export const easeOutCubic = (t: number): number =>
  1 - (1 - t) * (1 - t) * (1 - t);

/** Starts and ends slow: `c * c * (3 - 2 * c)`, where `c` is `clamp(t, 0, 1)`. */
export const smoothstep = (t: number): number => {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
};
