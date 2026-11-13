import { describe, expect, it } from "vitest";

import { ExactMath } from "./index";

const { cos, hashCell, hypot2, lerp, powInt, sin } = ExactMath;

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

describe("ExactMath.hypot2", () => {
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

describe("ExactMath.sin and ExactMath.cos", () => {
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

describe("ExactMath.powInt", () => {
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

describe("ExactMath.lerp", () => {
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

describe("ExactMath.hashCell", () => {
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
