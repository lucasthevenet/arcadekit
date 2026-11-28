/**
 * Two-dimensional vectors as plain numbers, for the inside of a loop.
 *
 *   (yield* Query.View(Moving)).each((velocity, steer) => {
 *     Vec2.clampLength(velocity, steer.x, steer.y, 1)   // writes the row
 *   })
 *
 * Every function takes the components as numbers and allocates nothing. One
 * that makes a vector writes it into `out`, any object with an `x` and a `y`:
 * a row of a query, which writes the component, or an object the caller makes
 * once and reuses.
 *
 * Each is made of `+`, `-`, `*`, `/` and `Math.sqrt`, which IEEE 754 rounds
 * one way on every machine, so a tick that uses them stays deterministic.
 *
 * A vector longer than about 1e154 or shorter than about 1e-154 is first
 * scaled by a power of two, since a double cannot hold the square of its
 * length: `Vec2.length(1e200, 0)` is `1e200`, not `Infinity`. Any other vector
 * is squared as it is.
 */

/**
 * Anything with an `x` and a `y` to write into, such as a row of a
 * `Transform2d.Position`.
 *
 * @category Models
 */
export interface Vec2 {
  x: number;
  y: number;
}

/** 2^-1022. Below it, a double holds fewer than 53 bits. */
const MIN_NORMAL = 2.2250738585072014e-308;
/** 2^600 and 2^-600. A product with either is exact while it stays above MIN_NORMAL. */
const SCALE_UP = 4.149515568880993e180;
const SCALE_DOWN = 2.409919865102884e-181;

/**
 * The power of two to multiply a vector by so that a double holds the square
 * of its length in full, from that square as `x * x + y * y` computes it: 1
 * when a double already holds it.
 */
const rescale = (squared: number): number =>
  squared === Infinity ? SCALE_DOWN : squared < MIN_NORMAL ? SCALE_UP : 1;

/**
 * Returns the length of a vector.
 *
 * @category Utilities
 */
export const length = (x: number, y: number): number => {
  const squared = x * x + y * y;
  const scale = rescale(squared);
  if (scale === 1) {
    return Math.sqrt(squared);
  }
  const sx = x * scale;
  const sy = y * scale;
  return Math.sqrt(sx * sx + sy * sy) / scale;
};

/**
 * Returns the distance between two points.
 *
 * **When to use**
 *
 * Use to measure or show a distance. To compare one with a radius, use
 * `Overlap.circles`, which takes no square root.
 *
 * @category Utilities
 */
export const distance = (
  ax: number,
  ay: number,
  bx: number,
  by: number
): number => length(bx - ax, by - ay);

/**
 * Writes into `out` the vector of length 1 in the direction of `(x, y)`, and
 * returns `out`. A vector of length 0 gives `(0, 0)`.
 *
 *   Vec2.normalize(aim, mouse.x - ship.x, mouse.y - ship.y)
 *
 * @category Utilities
 */
export const normalize = <V extends Vec2>(out: V, x: number, y: number): V => {
  const scale = rescale(x * x + y * y);
  const sx = x * scale;
  const sy = y * scale;
  const size = Math.sqrt(sx * sx + sy * sy);
  if (size === 0) {
    out.x = 0;
    out.y = 0;
  } else {
    out.x = sx / size;
    out.y = sy / size;
  }
  return out;
};

/**
 * Writes `(x, y)` into `out`, shortened to `max` if it is longer, and returns
 * `out`.
 *
 *   Vec2.clampLength(velocity, input.x, input.y, 1)   // diagonals no faster
 *
 * @category Utilities
 */
export const clampLength = <V extends Vec2>(
  out: V,
  x: number,
  y: number,
  max: number
): V => {
  const scale = rescale(x * x + y * y);
  const sx = x * scale;
  const sy = y * scale;
  const limit = max * scale;
  const squared = sx * sx + sy * sy;
  if (squared <= limit * limit) {
    out.x = x;
    out.y = y;
  } else {
    const size = Math.sqrt(squared);
    out.x = (sx / size) * max;
    out.y = (sy / size) * max;
  }
  return out;
};
