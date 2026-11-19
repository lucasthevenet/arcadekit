/**
 * The raw loops of the physics plugin: plain functions of a range of rows,
 * columns and numbers.
 *
 * This module imports nothing and closes over nothing, so that whatever
 * runs a loop needs only to have imported it: a system on the main thread
 * today, and a worker when systems run on several. A loop that needs a
 * service, the world's random numbers or `Commands` is not one of these:
 * it stays in its system, which reads what the loop needs and passes it in.
 */

/**
 * Pulls rows `[start, end)` down by `gravity`, then moves them by their
 * velocity. Each row reads and writes only itself, so the rows can be
 * shared out in any way and the result is the same.
 */
export const fall = (
  start: number,
  end: number,
  px: Float32Array,
  py: Float32Array,
  vx: Float32Array,
  vy: Float32Array,
  gravity: number,
  delta: number
): void => {
  for (let i = start; i < end; i += 1) {
    vy[i]! += gravity * delta;
    px[i]! += vx[i]! * delta;
    py[i]! += vy[i]! * delta;
  }
};
