// Timers and rates for a step. A timer is a number in the state, so it pauses, replays and
// hashes with the run, and nothing calls back: a step lowers it with `countDown`, reads it, and
// arms it by writing its length. A rate is a budget the step adds to, and `takeWhole` says how
// many whole units it holds. Exact operations only (ADR-0011).

/** `Math.max(0, value - by)`: a timer is ready at 0, and armed by writing its length. */
export const countDown = (value: number, by: number): number =>
  Math.max(0, value - by);

/**
 * The whole units in `amount`: `Math.floor(amount)` from 1 up, else 0.
 *
 * For a rate turned into whole things: add `perSecond * dt` to a budget each step, take the whole
 * units, and subtract what was taken. Below 2^53 that leaves the same bits as subtracting 1 in a
 * loop. NaN gives 0.
 */
export const takeWhole = (amount: number): number =>
  amount >= 1 ? Math.floor(amount) : 0;
