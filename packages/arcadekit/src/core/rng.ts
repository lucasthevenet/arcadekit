/** Small seeded random generator (mulberry32). Same seed, same run: needed for replays and multiplayer sync. */
export interface Rng {
  /** Float in [0, 1). */
  readonly next: () => number;
  /** Integer in [0, max). */
  readonly int: (max: number) => number;
  readonly range: (min: number, max: number) => number;
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
  return {
    next,
    int: (max) => Math.floor(next() * max),
    range: (min, max) => min + next() * (max - min),
  };
};
