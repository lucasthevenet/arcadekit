/**
 * The fixed-step clock: it turns a frame's time into a whole number of fixed simulation steps
 * (ADR-0003).
 *
 * A fixed step makes a game behave the same on a 60 Hz and a 144 Hz screen, and makes it
 * deterministic. `arcadekit/game`'s loop steps every game with one. The clock reads no time of
 * its own: its caller gives it each frame's.
 *
 * @since 0.7.0
 */
import type { Types } from "effect";
import { Inspectable, Pipeable, Predicate } from "effect";
import { dual } from "effect/Function";

const TypeId = "~arcadekit/core/FixedStepClock";

/**
 * A clock that runs whole fixed steps for the time it is given, and carries what is left over to
 * the next frame.
 *
 * **When to use**
 *
 * Under a loop that steps a simulation by the time between frames. A game declared with
 * `Game.Simulation` is stepped by `Game.Loop`, which keeps one.
 *
 * **Details**
 *
 * `stepSeconds` is the length of a step. `maxStepsPerFrame` caps the catch-up steps of one
 * frame, so a slow frame can't snowball into slower frames: a frame that reaches the cap drops
 * the backlog instead of fast-forwarding.
 *
 * **Example** (Stepping by a frame's time)
 *
 * ```ts
 * import { FixedStepClock } from "arcadekit/core";
 *
 * const clock = FixedStepClock.make({ stepSeconds: 0.125 });
 * let steps = 0;
 * const step = () => {
 *   steps += 1;
 * };
 * FixedStepClock.advance(clock, 0.3125, step); // => 2
 * FixedStepClock.advance(clock, 0.0625, step); // => 1
 * steps; // => 3
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface FixedStepClock
  extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  /** The length of one step, in seconds. */
  readonly stepSeconds: number;
  /** The most steps one frame runs. */
  readonly maxStepsPerFrame: number;
}

/** What the module's functions keep, which no caller reads. */
type Internal = Types.Mutable<FixedStepClock> & {
  /** Time given and not yet stepped, in seconds. */
  accumulator: number;
};

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: Internal) {
    return {
      _id: "FixedStepClock",
      stepSeconds: this.stepSeconds,
      maxStepsPerFrame: this.maxStepsPerFrame,
      accumulator: this.accumulator,
    };
  },
};

/**
 * Checks whether a value is a fixed-step clock.
 *
 * **When to use**
 *
 * Narrow an unknown value before advancing it.
 *
 * **Example** (Recognising a clock)
 *
 * ```ts
 * import { FixedStepClock } from "arcadekit/core";
 *
 * FixedStepClock.isFixedStepClock(FixedStepClock.make()); // => true
 * FixedStepClock.isFixedStepClock({ stepSeconds: 1 / 60 }); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isFixedStepClock = (value: unknown): value is FixedStepClock =>
  Predicate.hasProperty(value, TypeId);

/**
 * Makes a clock with nothing carried over.
 *
 * **When to use**
 *
 * Once per loop, with the length of its simulation's step.
 *
 * **Details**
 *
 * `stepSeconds` defaults to 1/60 and `maxStepsPerFrame` to 5.
 *
 * **Example** (Making a clock)
 *
 * ```ts
 * import { FixedStepClock } from "arcadekit/core";
 *
 * const clock = FixedStepClock.make();
 * clock.stepSeconds; // => 1 / 60
 * clock.maxStepsPerFrame; // => 5
 * FixedStepClock.make({ stepSeconds: 1 / 30 }).stepSeconds; // => 1 / 30
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = (options?: {
  readonly stepSeconds?: number;
  readonly maxStepsPerFrame?: number;
}): FixedStepClock => {
  const self = Object.create(Proto) as Internal;
  self.stepSeconds = options?.stepSeconds ?? 1 / 60;
  self.maxStepsPerFrame = options?.maxStepsPerFrame ?? 5;
  self.accumulator = 0;
  return self;
};

/**
 * Adds `frameSeconds` of time and calls `step` once per whole step owed, up to
 * `maxStepsPerFrame`. Returns the number of steps run.
 *
 * **When to use**
 *
 * Once per frame, with the time since the last one.
 *
 * **Details**
 *
 * What is left of a step is carried to the next frame. A frame that runs `maxStepsPerFrame`
 * steps drops the rest: the clock is too far behind to catch up. `step` is given the step's
 * length.
 *
 * **Example** (Dropping the backlog of a long frame)
 *
 * ```ts
 * import { FixedStepClock } from "arcadekit/core";
 *
 * const clock = FixedStepClock.make({ stepSeconds: 0.1, maxStepsPerFrame: 5 });
 * FixedStepClock.advance(clock, 10, () => undefined); // => 5
 * // Nothing carried over: half a step owes none.
 * FixedStepClock.advance(clock, 0.05, () => undefined); // => 0
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const advance: {
  (
    frameSeconds: number,
    step: (stepSeconds: number) => void
  ): (self: FixedStepClock) => number;
  (
    self: FixedStepClock,
    frameSeconds: number,
    step: (stepSeconds: number) => void
  ): number;
} = dual(
  3,
  (
    self: FixedStepClock,
    frameSeconds: number,
    step: (stepSeconds: number) => void
  ): number => {
    const clock = self as Internal;
    clock.accumulator += frameSeconds;
    let steps = 0;
    while (
      clock.accumulator >= clock.stepSeconds &&
      steps < clock.maxStepsPerFrame
    ) {
      step(clock.stepSeconds);
      clock.accumulator -= clock.stepSeconds;
      steps += 1;
    }
    // Too far behind: drop the backlog instead of fast-forwarding.
    if (steps === clock.maxStepsPerFrame) {
      clock.accumulator = 0;
    }
    return steps;
  }
);

/**
 * Forgets the time carried over.
 *
 * **When to use**
 *
 * When a new run starts on the same clock, so it owes no step of the last one.
 *
 * **Example** (Starting a run with nothing owed)
 *
 * ```ts
 * import { FixedStepClock } from "arcadekit/core";
 *
 * const clock = FixedStepClock.make({ stepSeconds: 0.125 });
 * FixedStepClock.advance(clock, 0.1, () => undefined); // => 0
 * FixedStepClock.reset(clock);
 * // Without the reset, the 0.1 carried over and this 0.1 would make a step.
 * FixedStepClock.advance(clock, 0.1, () => undefined); // => 0
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const reset = (self: FixedStepClock): void => {
  (self as Internal).accumulator = 0;
};
