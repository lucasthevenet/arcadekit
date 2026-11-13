/**
 * Points: two numbers, x and y, that a function writes for its caller, who owns the point.
 *
 * A function that gives two numbers writes them into a point it is handed, so a step that calls
 * it for every entity allocates nothing: the step makes its points once and reads them back
 * after each call. The axes are x and y, as a spatial grid's are: a 3D game on a ground plane
 * passes z as y. The arithmetic is exact (ADR-0011).
 *
 * @since 0.7.0
 */
import { Inspectable, Pipeable, Predicate } from "effect";
import { dual } from "effect/Function";

import { hypot2 } from "./exact-math";

const TypeId = "~arcadekit/core/Point2";

/**
 * Two numbers a function writes for its caller, who owns the point.
 *
 * **When to use**
 *
 * Make one for each pair of numbers a step asks a function for, once, beside the step, and read
 * `x` and `y` back after each call.
 *
 * **Details**
 *
 * `x` and `y` are plain fields: the module's functions write them, and so may the caller. A
 * point holds nothing between calls that a run needs, so it is no part of a run's state.
 *
 * **Example** (Reading a move back)
 *
 * ```ts
 * import { Point2 } from "arcadekit/core";
 *
 * const wish = Point2.make(0, 0);
 * Point2.clampLength(wish, 3, 4, 1);
 * [wish.x, wish.y]; // => [0.6, 0.8]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Point2 extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  x: number;
  y: number;
}

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: Point2) {
    return { _id: "Point2", x: this.x, y: this.y };
  },
};

/**
 * Checks whether a value is a point.
 *
 * **When to use**
 *
 * Narrow an unknown value before writing into it.
 *
 * **Details**
 *
 * An object with an `x` and a `y` is not a point: a point is made by `make`.
 *
 * **Example** (Recognising a point)
 *
 * ```ts
 * import { Point2 } from "arcadekit/core";
 *
 * Point2.isPoint2(Point2.make(0, 0)); // => true
 * Point2.isPoint2({ x: 0, y: 0 }); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isPoint2 = (value: unknown): value is Point2 =>
  Predicate.hasProperty(value, TypeId);

/**
 * Makes a point at `(x, y)`.
 *
 * **When to use**
 *
 * Once, beside the step that writes into it.
 *
 * **Example** (Making a point)
 *
 * ```ts
 * import { Point2 } from "arcadekit/core";
 *
 * const flown = Point2.make(1, 2);
 * [flown.x, flown.y]; // => [1, 2]
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = (x: number, y: number): Point2 => {
  const self = Object.create(Proto) as Point2;
  self.x = x;
  self.y = y;
  return self;
};

/**
 * Writes `(x, y)` into the point, shortened to `max` if longer. Returns the length it had.
 *
 * **When to use**
 *
 * To read a stick or keys as a move no faster than full speed: a diagonal of two keys is as
 * fast as one, and a stick's small tilt stays slow.
 *
 * **Details**
 *
 * A vector no longer than `max` is written as it is; a longer one as `(x / length) * max`, so
 * with a `max` of 1 it is `x / length` to the bit. `max` is 0 or more. The zero vector is
 * written as it is whatever `max` is, so nothing is divided by a length of 0.
 *
 * **Example** (Holding a diagonal to full speed)
 *
 * ```ts
 * import { Point2 } from "arcadekit/core";
 *
 * const wish = Point2.make(0, 0);
 * Point2.clampLength(wish, 1, 1, 1); // => 1.4142135623730951
 * [wish.x, wish.y]; // => [0.7071067811865475, 0.7071067811865475]
 * Point2.clampLength(wish, 0.25, 0, 1); // => 0.25
 * [wish.x, wish.y]; // => [0.25, 0]
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const clampLength: {
  (x: number, y: number, max: number): (self: Point2) => number;
  (self: Point2, x: number, y: number, max: number): number;
} = dual(4, (self: Point2, x: number, y: number, max: number): number => {
  const length = hypot2(x, y);
  if (length > max && length > 0) {
    self.x = (x / length) * max;
    self.y = (y / length) * max;
  } else {
    self.x = x;
    self.y = y;
  }
  return length;
});

/**
 * Writes into the point the place at most `maxStep` from `(x, y)` toward `(targetX, targetY)`:
 * the target itself once it is within `maxStep`.
 *
 * **When to use**
 *
 * For a thing that chases a point, such as a gem flying to the hero: it lands on its target and
 * never passes it.
 *
 * **Details**
 *
 * Beyond `maxStep` it is `x + (dx / distance) * maxStep`. `maxStep` is 0 or more. A thing
 * already on its target stays there whatever `maxStep` is, so nothing is divided by a distance
 * of 0.
 *
 * **Example** (Flying a gem to the hero)
 *
 * ```ts
 * import { Point2 } from "arcadekit/core";
 *
 * const flown = Point2.make(0, 0);
 * Point2.moveToward(flown, 0, 0, 10, 0, 3);
 * [flown.x, flown.y]; // => [3, 0]
 * Point2.moveToward(flown, 9, 0, 10, 0, 3);
 * [flown.x, flown.y]; // => [10, 0]
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const moveToward: {
  (
    x: number,
    y: number,
    targetX: number,
    targetY: number,
    maxStep: number
  ): (self: Point2) => void;
  (
    self: Point2,
    x: number,
    y: number,
    targetX: number,
    targetY: number,
    maxStep: number
  ): void;
} = dual(
  6,
  (
    self: Point2,
    x: number,
    y: number,
    targetX: number,
    targetY: number,
    maxStep: number
  ): void => {
    const dx = targetX - x;
    const dy = targetY - y;
    const distance = hypot2(dx, dy);
    if (distance <= maxStep || distance === 0) {
      self.x = targetX;
      self.y = targetY;
    } else {
      self.x = x + (dx / distance) * maxStep;
      self.y = y + (dy / distance) * maxStep;
    }
  }
);
