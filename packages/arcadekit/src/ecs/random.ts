/**
 * A seeded random number generator.
 *
 * The same seed produces the same numbers on every machine and in every
 * JavaScript engine: the generator is xoshiro128**, which uses only 32-bit
 * integer arithmetic, and a float is one of its outputs divided by 2^32.
 *
 * Its entire state is four 32-bit numbers in `state`. Each world owns one
 * generator (`world.random`), so its state is part of the world: it is included
 * in the world's hash, and copying it resumes the sequence where it left off.
 *
 * It is not suitable for secrets: anyone who sees a few outputs can predict the
 * rest.
 *
 * No Effect dependency.
 */

const TWO_32 = 4_294_967_296;

/** One step of splitmix32's output function, which maps each 32-bit number to a different one. */
const mix = (value: number): number => {
  let z = value | 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  return (z ^ (z >>> 15)) >>> 0;
};

const GOLDEN = 0x9e3779b9;

/**
 * A seeded random number generator, xoshiro128**. The same seed gives the
 * same numbers on every machine and in every JavaScript engine. Each world
 * owns one, as `world.random`, and its state is part of the world: a
 * snapshot, the hash and a rollback cover it.
 *
 * **When to use**
 *
 * Use `world.random` for every random number a simulation draws. In a game,
 * the `Random` service gives a system of the tick this generator.
 *
 * **Gotchas**
 *
 * It is not suitable for secrets: a few outputs reveal the rest.
 *
 * @category Models
 */
export class Rng {
  /**
   * The generator's entire state, four 32-bit numbers. Copy it to save the
   * generator, and write it back with `state.set` to resume from there.
   */
  readonly state: Uint32Array = new Uint32Array(4);

  /**
   * Makes a generator that starts from `seed`, an integer from 0 to
   * `Number.MAX_SAFE_INTEGER`, which defaults to 0. Any other seed throws.
   */
  constructor(seed = 0) {
    this.seed(seed);
  }

  /**
   * Restarts the sequence from a seed, an integer from 0 to
   * `Number.MAX_SAFE_INTEGER`. Two different seeds give different sequences.
   */
  seed(seed: number): void {
    if (!Number.isSafeInteger(seed) || seed < 0) {
      throw new Error(
        `A random seed must be a whole number from 0 to ${Number.MAX_SAFE_INTEGER}, and this one is ${seed}.`
      );
    }
    // Two seeds differ in their low or their high 32 bits, and `mix` never
    // maps two numbers to one, so two seeds never give the same state. The
    // state is never all zeros, the one state the generator cannot leave.
    const low = seed >>> 0;
    const high = Math.floor(seed / TWO_32);
    const { state } = this;
    state[0] = mix(low + GOLDEN);
    state[1] = mix(low + 2 * GOLDEN);
    state[2] = mix(high + 3 * GOLDEN);
    state[3] = mix(high + 4 * GOLDEN);
  }

  /** Returns the next 32 random bits, as an integer from 0 to 2^32 - 1. */
  bits(): number {
    const s = this.state;
    const s0 = s[0]!;
    let s1 = s[1]!;
    let s2 = s[2]!;
    let s3 = s[3]!;
    const scrambled = Math.imul(s1, 5);
    const result = Math.imul((scrambled << 7) | (scrambled >>> 25), 9) >>> 0;
    const shifted = s1 << 9;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s[0] = s0 ^ s3;
    s[1] = s1;
    s[2] = s2 ^ shifted;
    s[3] = (s3 << 11) | (s3 >>> 21);
    return result;
  }

  /** Returns a number from 0 up to, but not including, 1. */
  next(): number {
    return this.bits() / TWO_32;
  }

  /**
   * Returns an integer from `min` to `max`, both inclusive: `int(1, 6)` rolls a
   * die. Every value is equally likely. Both must be integers, with `max` no
   * less than `min` and at most 2^32 - 1 above it, or it throws.
   */
  int(min: number, max: number): number {
    const range = max - min + 1;
    if (
      !Number.isSafeInteger(min) ||
      !Number.isSafeInteger(max) ||
      range < 1 ||
      range > TWO_32
    ) {
      throw new Error(
        `Random.int(${min}, ${max}): both must be whole numbers, with max no less than min and no more than 2^32 - 1 above it.`
      );
    }
    // Reducing 32 bits with `%` alone would favour the low values whenever
    // the range does not divide 2^32. Draws at or above the largest multiple
    // of the range are thrown away instead, so each value keeps equal odds.
    const limit = TWO_32 - (TWO_32 % range);
    let drawn = this.bits();
    while (drawn >= limit) {
      drawn = this.bits();
    }
    return min + (drawn % range);
  }

  /**
   * Returns a number from `min` up to, but not including, `max`:
   * `range(2, 5)` for a speed of 2 to 5. Both must be finite, with `max` no
   * less than `min`, or it throws. `range(min, min)` is `min`.
   */
  range(min: number, max: number): number {
    if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
      throw new Error(
        `Random.range(${min}, ${max}): both must be finite numbers, with max no less than min.`
      );
    }
    return min + this.next() * (max - min);
  }

  /**
   * Returns true with the chance `p`, from 0, never, to 1, always:
   * `chance(0.1)` is true one time in ten. Any other `p` throws. It draws one
   * number whatever `p` is, so a replay draws the same.
   */
  chance(p: number): boolean {
    if (!(p >= 0 && p <= 1)) {
      throw new Error(
        `Random.chance(${p}): the chance must be a number from 0 to 1.`
      );
    }
    return this.next() < p;
  }

  /** Returns one of the items, each equally likely. Throws on an empty list. */
  pick<T>(items: ArrayLike<T>): T {
    if (items.length === 0) {
      throw new Error("Random.pick was given an empty list.");
    }
    return items[this.int(0, items.length - 1)]!;
  }

  /**
   * Shuffles an array in place and returns it. Every order is equally likely.
   */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const held = items[i]!;
      items[i] = items[j]!;
      items[j] = held;
    }
    return items;
  }
}
