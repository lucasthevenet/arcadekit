import { describe, expect, it } from "vitest";

import {
  clampLength,
  cos,
  hashCell,
  hypot2,
  lerp,
  moveToward,
  powInt,
  sin,
} from "./math";

// These functions exist to give the same bits in every engine (ADR-0011). Comparing them with
// this engine's Math checks they are accurate enough; the pinned literals check their bits stay
// put, since any change to them changes every run the simulation plays.

/** `count` points spread evenly over [lo, hi), by the golden ratio so they don't line up. */
const spread = (lo: number, hi: number, count: number): number[] =>
  Array.from(
    { length: count },
    (_, i) => lo + (hi - lo) * ((i * 0.6180339887498949) % 1)
  );

const worstAbsoluteError = (
  ours: (x: number) => number,
  reference: (x: number) => number,
  xs: readonly number[]
): number => Math.max(...xs.map((x) => Math.abs(ours(x) - reference(x))));

// 2^-52: one ulp at 1. sin and cos never exceed 1, so this is at most 1 ulp of the result
// except near their zeros, where the absolute error is what moves an entity.
const TRIG_TOLERANCE = 2 ** -52;

describe(hypot2, () => {
  it("is within 2 ulp of Math.hypot over the arena", () => {
    const xs = spread(-60, 60, 20_000);
    const zs = spread(-60, 60, 20_000).toReversed();
    let worst = 0;
    for (let i = 0; i < xs.length; i++) {
      const exact = Math.hypot(xs[i]!, zs[i]!);
      worst = Math.max(worst, Math.abs(hypot2(xs[i]!, zs[i]!) - exact) / exact);
    }
    expect(worst).toBeLessThanOrEqual(2 * Number.EPSILON);
  });

  it("is exact where the length is representable", () => {
    expect(hypot2(3, 4)).toBe(5);
    expect(hypot2(-5, 12)).toBe(13);
    expect(hypot2(0, -2)).toBe(2);
    expect(hypot2(0, 0)).toBe(0);
  });

  it("gives NaN for NaN", () => {
    expect(hypot2(Number.NaN, 1)).toBeNaN();
  });
});

describe("sin and cos", () => {
  it("match Math within 2^-52 on the spawn ring's angles, [0, 2pi)", () => {
    const angles = spread(0, 2 * Math.PI, 50_000);
    expect(worstAbsoluteError(sin, Math.sin, angles)).toBeLessThanOrEqual(
      TRIG_TOLERANCE
    );
    expect(worstAbsoluteError(cos, Math.cos, angles)).toBeLessThanOrEqual(
      TRIG_TOLERANCE
    );
  });

  it("match Math within 2^-52 for |x| up to 1000", () => {
    const xs = spread(-1000, 1000, 50_000);
    expect(worstAbsoluteError(sin, Math.sin, xs)).toBeLessThanOrEqual(
      TRIG_TOLERANCE
    );
    expect(worstAbsoluteError(cos, Math.cos, xs)).toBeLessThanOrEqual(
      TRIG_TOLERANCE
    );
  });

  it("are exact at 0 and keep the sign of -0", () => {
    expect(sin(0)).toBe(0);
    expect(Object.is(sin(-0), -0)).toBe(true);
    expect(cos(0)).toBe(1);
    expect(cos(-0)).toBe(1);
  });

  it("give NaN for NaN and the infinities", () => {
    for (const x of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(sin(x)).toBeNaN();
      expect(cos(x)).toBeNaN();
    }
  });

  it("give the same bits as when they were recorded, in every quadrant", () => {
    // Recorded from this code. A change here changes every survivors run: re-record only on
    // purpose, with the replay and determinism hashes.
    expect([0.5, 2, 3.5, 5, -1, 100].map(sin)).toStrictEqual([
      0.479425538604203, 0.9092974268256817, -0.35078322768961984,
      -0.9589242746631385, -0.8414709848078965, -0.5063656411097588,
    ]);
    expect([0.5, 2, 3.5, 5, -1, 100].map(cos)).toStrictEqual([
      0.8775825618903728, -0.4161468365471424, -0.9364566872907963,
      0.2836621854632263, 0.5403023058681398, 0.8623188722876839,
    ]);
  });
});

describe(powInt, () => {
  it("is exact where every product is representable", () => {
    expect([
      powInt(2, 10),
      powInt(3, 5),
      powInt(0.5, 8),
      powInt(-2, 3),
      powInt(2, -3),
      powInt(1.3, 1),
    ]).toStrictEqual([1024, 243, 0.00390625, -8, 0.125, 1.3]);
  });

  it("gives 1 for exponent 0, as ** does", () => {
    expect(powInt(0, 0)).toBe(1);
    expect(powInt(1.3, 0)).toBe(1);
    expect(powInt(Number.NaN, 0)).toBe(1);
  });

  it("multiplies in square-and-multiply order", () => {
    // The order fixes the rounding, so it fixes the bits. The exact 0.9^4 rounds to 0.6561.
    expect(powInt(0.9, 4)).toBe(0.9 * 0.9 * (0.9 * 0.9));
    expect(powInt(0.9, 4)).toBe(0.6561000000000001);
    expect(powInt(1.3, 3)).toBe(1.3 * (1.3 * 1.3));
    expect(powInt(1.3, 3)).toBe(2.1970000000000005);
  });

  it("is within a few ulp of ** for the curves content uses", () => {
    // XP growth over 60 levels, cooldown scaling over 10 weapon levels.
    for (const [base, levels] of [
      [1.3, 60],
      [1.15, 60],
      [0.9, 10],
      [0.95, 10],
    ] as const) {
      for (let n = 0; n <= levels; n++) {
        const reference = base ** n;
        expect(Math.abs(powInt(base, n) - reference) / reference).toBeLessThan(
          8 * Number.EPSILON
        );
      }
    }
  });

  it("rejects an exponent that is not an integer", () => {
    expect(() => powInt(2, 0.5)).toThrow(RangeError);
    expect(() => powInt(2, Number.NaN)).toThrow(RangeError);
  });
});

describe(lerp, () => {
  it("gives `from` at 0, `to` at 1 and the point between at a fraction", () => {
    expect(lerp(2, 10, 0)).toBe(2);
    expect(lerp(2, 10, 1)).toBe(10);
    expect(lerp(2, 10, 0.25)).toBe(4);
    expect(lerp(10, 2, 0.25)).toBe(8);
  });

  it("doesn't clamp `t`", () => {
    expect(lerp(2, 10, 1.5)).toBe(14);
    expect(lerp(2, 10, -0.5)).toBe(-2);
  });

  it("is `from + (to - from) * t`, in that order", () => {
    // The order fixes the rounding, so it fixes the bits: the other common form,
    // from * (1 - t) + to * t, gives 0.34 here.
    expect(lerp(0.1, 0.9, 0.3)).toBe(0.1 + (0.9 - 0.1) * 0.3);
    expect(lerp(0.1, 0.9, 0.3)).toBe(0.33999999999999997);
    expect(0.1 * (1 - 0.3) + 0.9 * 0.3).toBe(0.34);
  });
});

describe(clampLength, () => {
  it("leaves a vector no longer than `max` as it is, and returns its length", () => {
    const out = { x: 9, y: 9 };
    expect(clampLength(0.3, -0.4, 1, out)).toBe(0.5);
    expect(out).toStrictEqual({ x: 0.3, y: -0.4 });
  });

  it("leaves a vector exactly `max` long as it is: that is not longer", () => {
    const out = { x: 9, y: 9 };
    expect(clampLength(3, 4, 5, out)).toBe(5);
    expect(out).toStrictEqual({ x: 3, y: 4 });
    // Here shortening the vector to its own length would move x's last bit.
    const length = hypot2(0.2, -0.7);
    expect((0.2 / length) * length).toBe(0.20000000000000004);
    expect(clampLength(0.2, -0.7, length, out)).toBe(length);
    expect(out).toStrictEqual({ x: 0.2, y: -0.7 });
  });

  it("leaves no move as no move, whatever `max` is", () => {
    const out = { x: 9, y: 9 };
    // A `max` below 0 is a mistake, and still divides nothing by a length of 0.
    for (const max of [1, 0, -1, Number.NaN]) {
      out.x = 9;
      out.y = 9;
      expect(clampLength(0, 0, max, out)).toBe(0);
      expect(out).toStrictEqual({ x: 0, y: 0 });
    }
  });

  it("shortens a longer vector to `max`, and returns the length it had", () => {
    const out = { x: 9, y: 9 };
    expect(clampLength(0, -8, 2, out)).toBe(8);
    expect(out).toStrictEqual({ x: 0, y: -2 });
    expect(clampLength(6, 8, 5, out)).toBe(10);
    expect(out.x).toBeCloseTo(3, 12);
    expect(out.y).toBeCloseTo(4, 12);
  });

  it("gives x / length, bit for bit, at a `max` of 1", () => {
    // What a step did before it called this: `x /= length`. A run's hashes depend on it.
    const out = { x: 0, y: 0 };
    for (const [x, y] of [
      [0.7, 0.9],
      [-1, 1],
      [1.0001, 0],
      [-3.3, -0.1],
      [1e-3, 1e3],
    ] as const) {
      const length = hypot2(x, y);
      expect(length).toBeGreaterThan(1);
      expect(clampLength(x, y, 1, out)).toBe(length);
      expect(out).toStrictEqual({ x: x / length, y: y / length });
    }
    expect(clampLength(0.7, 0.9, 1, out)).toBe(1.140175425099138);
    expect(out).toStrictEqual({ x: 0.6139406135149204, y: 0.7893522173763262 });
  });

  it("is (x / length) * max, bit for bit, at any other `max`", () => {
    // A run's hashes depend on the order of these operations, so the bits are pinned where
    // the other orders give other bits.
    const out = { x: 0, y: 0 };
    clampLength(3.3, -0.1, 2.5, out);
    expect(out).toStrictEqual({
      x: 2.4988529478634534,
      y: -0.07572281660192284,
    });
    // (y * max) / length moves y's last bit there.
    expect((-0.1 * 2.5) / hypot2(3.3, -0.1)).toBe(-0.07572281660192283);
    clampLength(0.7, 0.9, 0.5, out);
    expect(out).toStrictEqual({ x: 0.3069703067574602, y: 0.3946761086881631 });
    // And y * (max / length) moves it here.
    expect(0.9 * (0.5 / hypot2(0.7, 0.9))).toBe(0.39467610868816316);
  });

  it("is the same expression on x as on y", () => {
    // The two vectors above with their axes swapped, so x is pinned as y is.
    const out = { x: 0, y: 0 };
    clampLength(-0.1, 3.3, 2.5, out);
    expect(out).toStrictEqual({
      x: -0.07572281660192284,
      y: 2.4988529478634534,
    });
    clampLength(0.9, 0.7, 0.5, out);
    expect(out).toStrictEqual({ x: 0.3946761086881631, y: 0.3069703067574602 });
  });
});

describe(moveToward, () => {
  it("lands on a target within `maxStep`", () => {
    const out = { x: 9, y: 9 };
    moveToward(1, 1, 4, 5, 6, out);
    expect(out).toStrictEqual({ x: 4, y: 5 });
    // Exactly `maxStep` away is within it.
    moveToward(1, 1, 4, 5, 5, out);
    expect(out).toStrictEqual({ x: 4, y: 5 });
    // So is this one, where going its whole distance toward it would miss x by its last bit.
    const distance = hypot2(0.2, -0.7);
    expect((0.2 / distance) * distance).toBe(0.20000000000000004);
    moveToward(0, 0, 0.2, -0.7, distance, out);
    expect(out).toStrictEqual({ x: 0.2, y: -0.7 });
  });

  it("stays on a target it is already on, whatever `maxStep` is", () => {
    const out = { x: 9, y: 9 };
    // A `maxStep` below 0 is a mistake, and still divides nothing by a distance of 0.
    for (const maxStep of [0, 0.3, -0.1, Number.NaN]) {
      out.x = 9;
      out.y = 9;
      moveToward(2, -2, 2, -2, maxStep, out);
      expect(out).toStrictEqual({ x: 2, y: -2 });
    }
  });

  it("goes `maxStep` toward a target beyond it", () => {
    const out = { x: 9, y: 9 };
    moveToward(1, 1, 4, 5, 2.5, out);
    expect(out).toStrictEqual({ x: 2.5, y: 3 });
    moveToward(0, 0, -10, 0, 0.25, out);
    expect(out).toStrictEqual({ x: -0.25, y: 0 });
  });

  it("is x + (dx / distance) * maxStep, bit for bit", () => {
    // A run's hashes depend on the order of these operations, so the bits are pinned where
    // the other orders give other bits.
    const out = { x: 0, y: 0 };
    moveToward(0.2, 0.4, 5.3, 3.9, 0.7, out);
    expect(out).toStrictEqual({ x: 0.7771593468506621, y: 0.7960897478386899 });
    const dx = 5.3 - 0.2;
    const dy = 3.9 - 0.4;
    const distance = hypot2(dx, dy);
    // dx * (maxStep / distance) moves x's last bit, and (dy * maxStep) / distance moves y's.
    expect(0.2 + dx * (0.7 / distance)).toBe(0.7771593468506623);
    expect(0.4 + (dy * 0.7) / distance).toBe(0.7960897478386898);
    // The same with the axes swapped, so each axis is pinned against both.
    moveToward(0.4, 0.2, 3.9, 5.3, 0.7, out);
    expect(out).toStrictEqual({ x: 0.7960897478386899, y: 0.7771593468506621 });
  });
});

describe(hashCell, () => {
  it("gives the same unsigned 32-bit integers as when they were recorded", () => {
    // Recorded from push-puzzle's floor hash, which this is. A change moves every tile variant
    // a view picks with it.
    expect(
      [
        [0, 0],
        [1, 0],
        [0, 1],
        [3, 7],
        [-2, 5],
        [1000, -1000],
        [12, 7],
      ].map(([col, row]) => hashCell(col!, row!))
    ).toStrictEqual([
      0, 148_680_139, 1_911_998_645, 192_003_539, 3_035_829_568, 276_471_881,
      4_087_697_978,
    ]);
  });

  it("spreads neighbouring cells evenly over a few variants", () => {
    const counts = Array.from({ length: 8 }, () => 0);
    for (let col = -50; col < 50; col++) {
      for (let row = -50; row < 50; row++) {
        const h = hashCell(col, row);
        expect(Number.isInteger(h) && h >= 0 && h < 2 ** 32).toBe(true);
        counts[h % 8]! += 1;
      }
    }
    // 10,000 cells over 8 variants: 1,250 each, give or take.
    expect(Math.min(...counts)).toBeGreaterThan(1150);
    expect(Math.max(...counts)).toBeLessThan(1350);
  });
});
