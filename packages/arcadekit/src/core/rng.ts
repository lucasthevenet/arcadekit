/**
 * The run's seeded random number generator (mulberry32): the same seed gives the same draws, on
 * every peer and in every replay.
 *
 * A step draws its randomness from its run's `Rng` and from nothing else (ADR-0017): not
 * `Math.random`, and not Effect's `Random`, which is not the run's.
 *
 * @since 0.7.0
 */
import type { Types } from "effect";
import { Inspectable, Pipeable, Predicate } from "effect";
import { dual } from "effect/Function";

const TypeId = "~arcadekit/core/Rng";

/**
 * A small seeded random number generator (mulberry32). Same seed, same draws: what replays and
 * lockstep need.
 *
 * **When to use**
 *
 * Keep one in a run's state, made from the seed its host gives `create`, and make every random
 * choice of the rules with it.
 *
 * **Details**
 *
 * Every draw advances `state`, and every later draw follows from `state` alone. The arithmetic is
 * 32-bit integer math (`Math.imul`, shifts), so every engine draws the same bits.
 *
 * **Example** (Drawing from a seeded generator)
 *
 * ```ts
 * import { Rng } from "arcadekit/core";
 *
 * const a = Rng.make(42);
 * const b = Rng.make(42);
 * Rng.next(a) === Rng.next(b); // => true
 * Rng.int(a, 6) === Rng.int(b, 6); // => true
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Rng extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  /** The generator's state, a 32-bit unsigned integer: every later draw follows from it alone. */
  readonly state: number;
}

/** What the module's functions write. */
type Internal = Types.Mutable<Rng>;

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: Rng) {
    return { _id: "Rng", state: this.state };
  },
};

/**
 * Checks whether a value is an `Rng`.
 *
 * **When to use**
 *
 * Narrow an unknown value before drawing from it.
 *
 * **Example** (Recognising a generator)
 *
 * ```ts
 * import { Rng } from "arcadekit/core";
 *
 * Rng.isRng(Rng.make(1)); // => true
 * Rng.isRng({ state: 1 }); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isRng = (value: unknown): value is Rng =>
  Predicate.hasProperty(value, TypeId);

/**
 * Makes a generator from `seed`.
 *
 * **When to use**
 *
 * Once per run, from the seed the host gives the simulation's `create`.
 *
 * **Details**
 *
 * The seed is read as a 32-bit unsigned integer (`seed >>> 0`), so seeds that differ only above
 * 32 bits give the same draws.
 *
 * **Example** (Seeding a run)
 *
 * ```ts
 * import { Rng } from "arcadekit/core";
 *
 * const rng = Rng.make(7);
 * rng.state; // => 7
 * Rng.make(4_294_967_303).state; // => 7
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = (seed: number): Rng => {
  const self = Object.create(Proto) as Internal;
  self.state = seed >>> 0;
  return self;
};

/**
 * Draws a number in `[0, 1)`.
 *
 * **When to use**
 *
 * For a chance, an angle or a position: multiply it into the range you need, or use `range`.
 *
 * **Details**
 *
 * It advances the generator once.
 *
 * **Example** (Rolling a chance)
 *
 * ```ts
 * import { Rng } from "arcadekit/core";
 *
 * const rng = Rng.make(1);
 * const roll = Rng.next(rng);
 * roll >= 0 && roll < 1; // => true
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const next = (self: Rng): number => {
  const rng = self as Internal;
  rng.state = (rng.state + 0x6d_2b_79_f5) >>> 0;
  let t = rng.state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};

/**
 * Draws a whole number in `[0, max)`: `Math.floor(next(self) * max)`.
 *
 * **When to use**
 *
 * To pick one of `max` things, such as an index into a list.
 *
 * **Details**
 *
 * It advances the generator once.
 *
 * **Example** (Picking an index)
 *
 * ```ts
 * import { Rng } from "arcadekit/core";
 *
 * const waves = ["grunts", "bats", "slimes"];
 * const rng = Rng.make(3);
 * const i = Rng.int(rng, waves.length);
 * Number.isInteger(i) && i >= 0 && i < 3; // => true
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const int: {
  (max: number): (self: Rng) => number;
  (self: Rng, max: number): number;
} = dual(2, (self: Rng, max: number): number => Math.floor(next(self) * max));

/**
 * Draws a number in `[min, max)`: `min + next(self) * (max - min)`.
 *
 * **When to use**
 *
 * For a value spread over a range, such as how far from the hero an enemy spawns.
 *
 * **Details**
 *
 * It advances the generator once.
 *
 * **Example** (Drawing a spawn distance)
 *
 * ```ts
 * import { Rng } from "arcadekit/core";
 *
 * const rng = Rng.make(9);
 * const distance = Rng.range(rng, 16, 22);
 * distance >= 16 && distance < 22; // => true
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const range: {
  (min: number, max: number): (self: Rng) => number;
  (self: Rng, min: number, max: number): number;
} = dual(
  3,
  (self: Rng, min: number, max: number): number =>
    min + next(self) * (max - min)
);

/** A list `pickDistinct` reorders in place: an array, or a typed array. */
type Reorderable<T> =
  | T[]
  | (ArrayBufferView & { readonly length: number; [index: number]: T });

/**
 * Moves `count` items drawn without repeats to the front of `items`, in place, and returns how
 * many: `count`, or `items.length` if that is less.
 *
 * **When to use**
 *
 * To offer several different things at once, such as a level-up's upgrades, or to pick several
 * entities of a pool by their indices.
 *
 * **Details**
 *
 * A partial Fisher-Yates shuffle: for each `i` below the returned number, one draw
 * `j = i + int(items.length - i)`, then a swap of `i` and `j`. The number of draws is part of the
 * contract, the last `int(1)` included: every later draw follows from it.
 *
 * `items` is an array or a typed array, so a pick of pool indices allocates nothing. It is
 * reordered, so a `readonly` list is a type error: a game picks from a copy of one. `count` is a
 * whole number of 0 or more, and any other throws a `RangeError` before anything is drawn.
 *
 * **Example** (Offering three different upgrades)
 *
 * ```ts
 * import { Rng } from "arcadekit/core";
 *
 * const upgrades = ["boost", "magnet", "shield", "bolt", "aura"];
 * const rng = Rng.make(2026);
 * const picked = Rng.pickDistinct(rng, upgrades, 3);
 * picked; // => 3
 * new Set(upgrades.slice(0, picked)).size; // => 3
 * upgrades.length; // => 5
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const pickDistinct: {
  <T>(items: Reorderable<T>, count: number): (self: Rng) => number;
  <T>(self: Rng, items: Reorderable<T>, count: number): number;
} = dual(3, <T>(self: Rng, items: Reorderable<T>, count: number): number => {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(
      `Rng.pickDistinct needs a whole count of 0 or more, got ${count}`
    );
  }
  const picked = Math.min(count, items.length);
  for (let i = 0; i < picked; i++) {
    const j = i + int(self, items.length - i);
    const drawn = items[j]!;
    items[j] = items[i]!;
    items[i] = drawn;
  }
  return picked;
});
