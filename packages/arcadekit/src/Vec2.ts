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

/**
 * Returns the length of a vector.
 *
 * @category Utilities
 */
export const length = (x: number, y: number): number =>
  Math.sqrt(x * x + y * y);

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
  const size = length(x, y);
  if (size === 0) {
    out.x = 0;
    out.y = 0;
  } else {
    out.x = x / size;
    out.y = y / size;
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
  const squared = x * x + y * y;
  if (squared <= max * max) {
    out.x = x;
    out.y = y;
  } else {
    const size = Math.sqrt(squared);
    out.x = (x / size) * max;
    out.y = (y / size) * max;
  }
  return out;
};
