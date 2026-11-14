/**
 * Exact math for a step: deterministic replacements for the `Math` functions a simulation needs,
 * and the small helpers built on them.
 *
 * ECMA-262 lets engines approximate `Math.hypot`, `sin`, `cos` and `**` however they like, and
 * V8, JavaScriptCore and two V8 versions give different last bits for them. A lockstep peer that
 * steps on another engine would drift. Everything here uses only what the spec defines exactly: `+ - * /`, `Math.sqrt`,
 * `Math.round`, `Math.floor`, `Math.min` and `Math.max` (IEEE 754, rounded ties-to-even, never
 * fused), and for the hash `Math.imul` and bit operations. So every conforming engine returns
 * the same bits.
 *
 * Each replacement trades a little accuracy against `Math`'s for that guarantee. Nothing here
 * allocates.
 *
 * @since 0.7.0
 */
import { dual } from "effect/Function";

/**
 * `value` held between `min` and `max`: `Math.min(Math.max(value, min), max)`.
 *
 * **When to use**
 *
 * To keep a position inside the arena, or a number inside the range a rule allows.
 *
 * **Details**
 *
 * `min` is at most `max`. NaN stays NaN.
 *
 * **Example** (Keeping a hero inside the arena)
 *
 * ```ts
 * import { ExactMath } from "arcadekit/core";
 *
 * ExactMath.clamp(42, -40, 40); // => 40
 * ExactMath.clamp(-3, -40, 40); // => -3
 * ```
 *
 * @category math
 * @since 0.7.0
 */
export const clamp: {
  (min: number, max: number): (value: number) => number;
  (value: number, min: number, max: number): number;
} = dual(3, (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max)
);

/**
 * The value `t` of the way from `from` to `to`: `from + (to - from) * t`.
 *
 * **When to use**
 *
 * To draw a thing between two places, as a view slides a box from one cell to the next.
 *
 * **Details**
 *
 * `t` is not clamped: past 1 it goes beyond `to`, and below 0 behind `from`. Give it a tween's
 * eased progress to stop at the ends.
 *
 * **Example** (Sliding between two cells)
 *
 * ```ts
 * import { ExactMath } from "arcadekit/core";
 *
 * ExactMath.lerp(10, 20, 0.25); // => 12.5
 * ExactMath.lerp(10, 20, 1.5); // => 25
 * ```
 *
 * @category math
 * @since 0.7.0
 */
export const lerp: {
  (to: number, t: number): (from: number) => number;
  (from: number, to: number, t: number): number;
} = dual(
  3,
  (from: number, to: number, t: number): number => from + (to - from) * t
);

/**
 * The length of the vector `(x, y)`: `Math.sqrt(x * x + y * y)`.
 *
 * **When to use**
 *
 * In a step, wherever it would call `Math.hypot`: a distance, a speed, a length to normalise by.
 *
 * **Details**
 *
 * Same bits in every engine. It rounds twice (the sum, then the root), so it is within about
 * 1 ulp of the exact length and misses the correctly rounded one on roughly 1 input in 10; no
 * engine's `Math.hypot` is correctly rounded on every input either. Unlike `Math.hypot` it doesn't
 * rescale, so it overflows to Infinity once |x| or |y| passes ~1e154 and loses precision below
 * ~1e-154; arena coordinates never get near either. NaN in, NaN out.
 *
 * **Example** (Measuring a distance)
 *
 * ```ts
 * import { ExactMath } from "arcadekit/core";
 *
 * ExactMath.hypot2(3, 4); // => 5
 * ExactMath.hypot2(-6, 8); // => 10
 * ```
 *
 * @category math
 * @since 0.7.0
 */
export const hypot2: {
  (y: number): (x: number) => number;
  (x: number, y: number): number;
} = dual(2, (x: number, y: number): number =>
  // oxlint-disable-next-line unicorn/prefer-modern-math-apis -- Math.hypot is the engine-dependent call this replaces.
  Math.sqrt(x * x + y * y)
);

// fdlibm's kernel polynomials (FreeBSD k_sin.c and k_cos.c, with tail y = 0), valid on
// [-pi/4, pi/4].
const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.0875723212981748279e-9;
const C6 = -1.13596475577881948265e-11;

const kernelSin = (x: number): number => {
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return x + v * (S1 + z * r);
};

const kernelCos = (x: number): number => {
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  const hz = 0.5 * z;
  const w = 1 - hz;
  return w + (1 - w - hz + z * r);
};

// Cody-Waite reduction by pi/2: PIO2_HI holds pi/2's first 33 bits, so `n * PIO2_HI` is exact
// while |n| < 2^20, and PIO2_LO is the next 53 bits of the remainder.
const INV_PIO2 = 6.36619772367581382433e-1;
const PIO2_HI = 1.57079632673412561417;
const PIO2_LO = 6.07710050650619224932e-11;

/** x minus the nearest multiple of pi/2, n: in [-pi/4, pi/4] up to rounding. */
const reduced = (x: number, n: number): number => x - n * PIO2_HI - n * PIO2_LO;

/** Which quarter turn n lands in, 0 to 3, for any integer n. */
const quadrant = (n: number): number => ((n % 4) + 4) % 4;

/**
 * The sine of `x` radians, the same bits in every engine.
 *
 * **When to use**
 *
 * In a step, wherever it would call `Math.sin`: a spawn's place on a ring, a wave's offset.
 *
 * **Details**
 *
 * fdlibm's kernel polynomial after a two-term Cody-Waite reduction by pi/2. Within 1 ulp of a
 * correctly rounded `Math.sin` for |x| <= 1000 (the simulation passes angles in [0, 2pi)), except
 * next to the zeros (multiples of pi/2): the two-term split of pi/2 leaves about 1e-26 of error,
 * so there the result is under 1e-25 off absolute but can be many ulp off relative (`sin(Math.PI)`
 * is ~3e5 ulp from the correctly rounded value). Under 2e-16 absolute up to |x| ~ 1.6e6, where
 * `n * PIO2_HI` stops being exact. Past that it loses accuracy fast (fdlibm switches to a longer
 * reduction there); it is still the same bits everywhere, just not a good sine. Keeps -0, and
 * gives NaN for NaN and +-Infinity.
 *
 * **Example** (Placing a spawn on a ring)
 *
 * ```ts
 * import { ExactMath } from "arcadekit/core";
 *
 * ExactMath.sin(0); // => 0
 * ExactMath.sin(Math.PI / 2); // => 1
 * Math.abs(ExactMath.sin(Math.PI / 6) - 0.5) < 1e-15; // => true
 * ```
 *
 * @category math
 * @since 0.7.0
 */
export const sin = (x: number): number => {
  if (x === 0) {
    return x;
  }
  const n = Math.round(x * INV_PIO2);
  const r = reduced(x, n);
  switch (quadrant(n)) {
    case 0: {
      return kernelSin(r);
    }
    case 1: {
      return kernelCos(r);
    }
    case 2: {
      return -kernelSin(r);
    }
    default: {
      return -kernelCos(r);
    }
  }
};

/**
 * The cosine of `x` radians, the same bits in every engine.
 *
 * **When to use**
 *
 * In a step, wherever it would call `Math.cos`.
 *
 * **Details**
 *
 * The same method, accuracy and domain as `sin`. Gives NaN for NaN and +-Infinity.
 *
 * **Example** (Taking the other axis of an angle)
 *
 * ```ts
 * import { ExactMath } from "arcadekit/core";
 *
 * ExactMath.cos(0); // => 1
 * ExactMath.cos(Math.PI); // => -1
 * ```
 *
 * @category math
 * @since 0.7.0
 */
export const cos = (x: number): number => {
  const n = Math.round(x * INV_PIO2);
  const r = reduced(x, n);
  switch (quadrant(n)) {
    case 0: {
      return kernelCos(r);
    }
    case 1: {
      return -kernelSin(r);
    }
    case 2: {
      return -kernelCos(r);
    }
    default: {
      return kernelSin(r);
    }
  }
};

/**
 * `base` raised to the integer `exponent`, by square-and-multiply: the same bits in every engine.
 *
 * **When to use**
 *
 * In a step, wherever it would write `**` or call `Math.pow` with a whole exponent, such as a
 * cooldown that shrinks by a factor each level.
 *
 * **Details**
 *
 * Exact whenever every intermediate product is representable (`2 ** 10`, `3 ** 5`, `0.5 ** 8`).
 * Otherwise each of its ~2·log2(|exponent|) multiplications rounds once, so it can be a few ulp
 * from the correctly rounded power. A negative exponent takes the reciprocal of the positive
 * power, which rounds once more. It throws a `RangeError` for an exponent that is not an
 * integer: those need a real `pow`, which the simulation must not call.
 *
 * **Example** (Scaling a cooldown by level)
 *
 * ```ts
 * import { ExactMath } from "arcadekit/core";
 *
 * ExactMath.powInt(2, 10); // => 1024
 * ExactMath.powInt(2, -2); // => 0.25
 * ExactMath.powInt(0.9, 4); // => 0.6561000000000001
 * ```
 *
 * @category math
 * @since 0.7.0
 */
export const powInt: {
  (exponent: number): (base: number) => number;
  (base: number, exponent: number): number;
} = dual(2, (base: number, exponent: number): number => {
  if (!Number.isInteger(exponent)) {
    throw new RangeError(
      `ExactMath.powInt needs an integer exponent, got ${exponent}`
    );
  }
  let remaining = Math.abs(exponent);
  let square = base;
  let result = 1;
  while (remaining > 0) {
    if (remaining % 2 === 1) {
      result *= square;
    }
    square *= square;
    remaining = Math.floor(remaining / 2);
  }
  return exponent < 0 ? 1 / result : result;
});

/**
 * A well-spread unsigned 32-bit integer from two whole numbers: a cell's column and row, or an
 * index and a salt.
 *
 * **When to use**
 *
 * To vary what a view draws per cell (a floor's tile, a tuft of grass) the same way every frame
 * and on every peer, with no random draw.
 *
 * **Details**
 *
 * `Math.imul` and shifts only, so the same in every engine. A caller takes `% count` of it to
 * pick one of `count` things, or divides it by 2^32 for a number in `[0, 1)`.
 *
 * **Example** (Picking a floor tile for a cell)
 *
 * ```ts
 * import { ExactMath } from "arcadekit/core";
 *
 * const variants = 4;
 * const tile = ExactMath.hashCell(3, 7) % variants;
 * tile === ExactMath.hashCell(3, 7) % variants; // => true
 * Number.isInteger(tile) && tile >= 0 && tile < variants; // => true
 * ```
 *
 * @category math
 * @since 0.7.0
 */
export const hashCell: {
  (row: number): (col: number) => number;
  (col: number, row: number): number;
} = dual(2, (col: number, row: number): number => {
  let h = Math.imul(col, 0x27_d4_eb_2d) ^ Math.imul(row, 0x16_56_67_b1);
  h = Math.imul(h ^ (h >>> 15), 0x85_eb_ca_6b);
  return (h ^ (h >>> 13)) >>> 0;
});
