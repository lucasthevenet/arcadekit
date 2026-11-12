/** Small seeded random generator (mulberry32). Same seed, same run: needed for replays and multiplayer sync. */
export interface Rng {
  /** Float in [0, 1). */
  readonly next: () => number;
  /** Integer in [0, max). */
  readonly int: (max: number) => number;
  readonly range: (min: number, max: number) => number;
  /**
   * Moves `count` items drawn without repeats to the front of `items`, in place, and returns
   * how many: `count`, or `items.length` if that is less.
   *
   * A partial Fisher-Yates shuffle: for each `i` below the returned number, one draw
   * `j = i + int(items.length - i)`, then a swap of `i` and `j`. The number of draws is part of
   * the contract, the last `int(1)` included: every later draw follows from it.
   *
   * `items` is an array or a typed array, so a pick of pool indices allocates nothing. It is
   * reordered, so a `readonly` list is a type error: a game picks from a copy of one. `count` is
   * a whole number of 0 or more, and `makeRng`'s pick throws a RangeError for any other, before
   * it draws.
   */
  readonly pickDistinct: <T>(
    items:
      | T[]
      | (ArrayBufferView & { readonly length: number; [index: number]: T }),
    count: number
  ) => number;
}

export const makeRng = (seed: number): Rng => {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (max: number) => Math.floor(next() * max);
  return {
    next,
    int,
    range: (min, max) => min + next() * (max - min),
    pickDistinct: (items, count) => {
      if (!Number.isInteger(count) || count < 0) {
        throw new RangeError(
          `pickDistinct needs a whole count of 0 or more, got ${count}`
        );
      }
      const picked = Math.min(count, items.length);
      for (let i = 0; i < picked; i++) {
        const j = i + int(items.length - i);
        const drawn = items[j]!;
        items[j] = items[i]!;
        items[i] = drawn;
      }
      return picked;
    },
  };
};
