/**
 * Timers and rates for a step.
 *
 * A timer is a number in the state, so it pauses, replays and hashes with the run, and nothing
 * calls back: a step lowers it with `countDown`, reads it, and arms it by writing its length. A
 * rate is a budget the step adds to, and `takeWhole` says how many whole units it holds. Exact
 * operations only (ADR-0011).
 *
 * @since 0.7.0
 */
import { dual } from "effect/Function";

/**
 * `Math.max(0, value - by)`: a timer lowered by a step's time, and stopped at 0.
 *
 * **When to use**
 *
 * Each step, on every timer of the state: a weapon's cooldown, a hurt flash, an invulnerability.
 * A timer is ready at 0, and armed by writing its length.
 *
 * **Example** (Firing when a cooldown is ready)
 *
 * ```ts
 * import { Timer } from "arcadekit/core";
 *
 * const weapon = { cooldown: 0.5, timer: 0.02 };
 * const dt = 1 / 60;
 * weapon.timer = Timer.countDown(weapon.timer, dt);
 * weapon.timer === 0; // => false
 * weapon.timer = Timer.countDown(weapon.timer, dt);
 * weapon.timer; // => 0
 * ```
 *
 * @category math
 * @since 0.7.0
 */
export const countDown: {
  (by: number): (value: number) => number;
  (value: number, by: number): number;
} = dual(2, (value: number, by: number): number => Math.max(0, value - by));

/**
 * The whole units in `amount`: `Math.floor(amount)` from 1 up, else 0.
 *
 * **When to use**
 *
 * For a rate turned into whole things, such as enemies spawned per second: add
 * `perSecond * dt` to a budget each step, take the whole units, and subtract what was taken.
 *
 * **Details**
 *
 * Below 2^53 that leaves the same bits as subtracting 1 in a loop. NaN gives 0.
 *
 * **Example** (Spawning at a rate)
 *
 * ```ts
 * import { Timer } from "arcadekit/core";
 *
 * let budget = 0;
 * let spawned = 0;
 * for (let step = 0; step < 60; step++) {
 *   budget += 6 / 60;
 *   const due = Timer.takeWhole(budget);
 *   spawned += due;
 *   budget -= due;
 * }
 * spawned; // => 5
 * ```
 *
 * @category math
 * @since 0.7.0
 */
export const takeWhole = (amount: number): number =>
  amount >= 1 ? Math.floor(amount) : 0;
