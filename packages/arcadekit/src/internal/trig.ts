/**
 * A sine and a cosine that give the same bits in every JavaScript engine,
 * where ECMAScript lets each engine round `Math.sin` and `Math.cos` its own
 * way. They are fdlibm's, as V8's `Math.sin` and `Math.cos` are, made of `+`,
 * `-`, `*` and `/`, which IEEE 754 rounds one way. Below 2^20 π/2 they give
 * V8's bits. Above it, the angle is first taken modulo 2π with `%`, which is
 * exact, and the result is within a rounding of the angle itself.
 */

const view = new DataView(new ArrayBuffer(8));

const highWordOfMagnitude = (x: number): number => {
  view.setFloat64(0, x);
  return view.getUint32(0) & 0x7fffffff;
};

const withHighWord = (word: number): number => {
  view.setUint32(0, word);
  view.setUint32(4, 0);
  return view.getFloat64(0);
};

const TURN = 2 * Math.PI;

const INV_PIO2 = 0.6366197723675814;
const PIO2_1 = 1.5707963267341256;
const PIO2_1T = 6.077100506506192e-11;
const PIO2_2 = 6.077100506303966e-11;
const PIO2_2T = 2.0222662487959506e-21;
const PIO2_3 = 2.0222662487111665e-21;
const PIO2_3T = 8.4784276603689e-32;

const S1 = -0.16666666666666632;
const S2 = 0.00833333333332249;
const S3 = -0.0001984126982985795;
const S4 = 0.0000027557313707070068;
const S5 = -2.5050760253406863e-8;
const S6 = 1.58969099521155e-10;

const C1 = 0.0416666666666666;
const C2 = -0.001388888888887411;
const C3 = 0.00002480158728947673;
const C4 = -2.7557314351390663e-7;
const C5 = 2.087572321298175e-9;
const C6 = -1.1359647557788195e-11;

/** The sine of `x + tail` for |x| up to π/4, as fdlibm's `__kernel_sin`. */
const kernelSin = (x: number, tail: number, hasTail: boolean): number => {
  if (highWordOfMagnitude(x) < 0x3e400000) {
    return x;
  }
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return hasTail
    ? x - (z * (0.5 * tail - v * r) - tail - v * S1)
    : x + v * (S1 + z * r);
};

/** The cosine of `x + tail` for |x| up to π/4, as fdlibm's `__kernel_cos`. */
const kernelCos = (x: number, tail: number): number => {
  const ix = highWordOfMagnitude(x);
  if (ix < 0x3e400000) {
    return 1;
  }
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  if (ix < 0x3fd33333) {
    return 1 - (0.5 * z - (z * r - x * tail));
  }
  const qx = ix > 0x3fe90000 ? 0.28125 : withHighWord(ix - 0x00200000);
  return 1 - qx - (0.5 * z - qx - (z * r - x * tail));
};

/**
 * The sine of `x` plus `quarters` quarter turns, for π/4 < |x| < 2^20 π/2,
 * from `x` less its nearest multiple of π/2, as fdlibm's
 * `__ieee754_rem_pio2` takes it.
 */
const turned = (x: number, quarters: number): number => {
  const ix = highWordOfMagnitude(x);
  const t = Math.abs(x);
  let n = 1;
  let r: number;
  let w: number;
  if (ix < 0x4002d97c) {
    r = t - PIO2_1;
    w = PIO2_1T;
    if (ix === 0x3ff921fb) {
      r -= PIO2_2;
      w = PIO2_2T;
    }
  } else {
    n = Math.trunc(t * INV_PIO2 + 0.5);
    r = t - n * PIO2_1;
    w = n * PIO2_1T;
    const exponent = ix >>> 20;
    if (exponent - (highWordOfMagnitude(r - w) >>> 20) > 16) {
      let s = r;
      w = n * PIO2_2;
      r = s - w;
      w = n * PIO2_2T - (s - r - w);
      if (exponent - (highWordOfMagnitude(r - w) >>> 20) > 49) {
        s = r;
        w = n * PIO2_3;
        r = s - w;
        w = n * PIO2_3T - (s - r - w);
      }
    }
  }
  let y0 = r - w;
  let y1 = r - y0 - w;
  if (x < 0) {
    y0 = -y0;
    y1 = -y1;
    n = -n;
  }
  switch ((n + quarters) & 3) {
    case 0:
      return kernelSin(y0, y1, true);
    case 1:
      return kernelCos(y0, y1);
    case 2:
      return -kernelSin(y0, y1, true);
    default:
      return -kernelCos(y0, y1);
  }
};

/**
 * The sine of `x`, the same in every engine.
 *
 * @internal
 */
export const sine = (x: number): number => {
  const ix = highWordOfMagnitude(x);
  if (ix <= 0x3fe921fb) {
    return kernelSin(x, 0, false);
  }
  if (ix >= 0x7ff00000) {
    return Number.NaN;
  }
  return ix > 0x413921fb ? sine(x % TURN) : turned(x, 0);
};

/**
 * The cosine of `x`, the same in every engine.
 *
 * @internal
 */
export const cosine = (x: number): number => {
  const ix = highWordOfMagnitude(x);
  if (ix <= 0x3fe921fb) {
    return kernelCos(x, 0);
  }
  if (ix >= 0x7ff00000) {
    return Number.NaN;
  }
  return ix > 0x413921fb ? cosine(x % TURN) : turned(x, 1);
};
