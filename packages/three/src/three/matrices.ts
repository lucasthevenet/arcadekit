// What each instance's matrix is, from its entity's transform: written into
// the mesh's buffer, sixteen numbers an instance, from `at` on.

import type { Angle, Xy, Xyz, Xyzw } from "./which";

/**
 * Entities with only a position: drawn unrotated, at the geometry's size.
 *
 * @internal
 */
export const placed = (
  out: Float32Array,
  at: number,
  start: number,
  end: number,
  position: Xyz
): void => {
  const { x, y, z } = position;
  for (let i = start; i < end; i++) {
    out[at] = 1;
    out[at + 1] = 0;
    out[at + 2] = 0;
    out[at + 3] = 0;
    out[at + 4] = 0;
    out[at + 5] = 1;
    out[at + 6] = 0;
    out[at + 7] = 0;
    out[at + 8] = 0;
    out[at + 9] = 0;
    out[at + 10] = 1;
    out[at + 11] = 0;
    out[at + 12] = x[i]!;
    out[at + 13] = y[i]!;
    out[at + 14] = z[i]!;
    out[at + 15] = 1;
    at += 16;
  }
};

/**
 * Entities with a position and a scale.
 *
 * @internal
 */
export const sized = (
  out: Float32Array,
  at: number,
  start: number,
  end: number,
  position: Xyz,
  scale: Xyz
): void => {
  const { x, y, z } = position;
  const { x: sx, y: sy, z: sz } = scale;
  for (let i = start; i < end; i++) {
    out[at] = sx[i]!;
    out[at + 1] = 0;
    out[at + 2] = 0;
    out[at + 3] = 0;
    out[at + 4] = 0;
    out[at + 5] = sy[i]!;
    out[at + 6] = 0;
    out[at + 7] = 0;
    out[at + 8] = 0;
    out[at + 9] = 0;
    out[at + 10] = sz[i]!;
    out[at + 11] = 0;
    out[at + 12] = x[i]!;
    out[at + 13] = y[i]!;
    out[at + 14] = z[i]!;
    out[at + 15] = 1;
    at += 16;
  }
};

/**
 * Rotated entities: a matrix from the position and the quaternion.
 *
 * @internal
 */
export const turned = (
  out: Float32Array,
  at: number,
  start: number,
  end: number,
  position: Xyz,
  rotation: Xyzw
): void => {
  const { x, y, z } = position;
  const { x: qx, y: qy, z: qz, w: qw } = rotation;
  for (let i = start; i < end; i++) {
    const a = qx[i]!;
    const b = qy[i]!;
    const c = qz[i]!;
    const d = qw[i]!;
    // Twice over its length squared, which is 2 for a quaternion of
    // length 1: one of any other length draws as the turn it stands
    // for, and not skewed. All zeros is no turn at all.
    const n = a * a + b * b + c * c + d * d;
    const s = n > 0 ? 2 / n : 0;
    const a2 = a * s;
    const b2 = b * s;
    const c2 = c * s;
    out[at] = 1 - (b * b2 + c * c2);
    out[at + 1] = a * b2 + d * c2;
    out[at + 2] = a * c2 - d * b2;
    out[at + 3] = 0;
    out[at + 4] = a * b2 - d * c2;
    out[at + 5] = 1 - (a * a2 + c * c2);
    out[at + 6] = b * c2 + d * a2;
    out[at + 7] = 0;
    out[at + 8] = a * c2 + d * b2;
    out[at + 9] = b * c2 - d * a2;
    out[at + 10] = 1 - (a * a2 + b * b2);
    out[at + 11] = 0;
    out[at + 12] = x[i]!;
    out[at + 13] = y[i]!;
    out[at + 14] = z[i]!;
    out[at + 15] = 1;
    at += 16;
  }
};

/**
 * Entities with all three: what `Matrix4.compose` computes, written out.
 *
 * @internal
 */
export const whole = (
  out: Float32Array,
  at: number,
  start: number,
  end: number,
  position: Xyz,
  rotation: Xyzw,
  scale: Xyz
): void => {
  const { x, y, z } = position;
  const { x: qx, y: qy, z: qz, w: qw } = rotation;
  const { x: sx, y: sy, z: sz } = scale;
  for (let i = start; i < end; i++) {
    const a = qx[i]!;
    const b = qy[i]!;
    const c = qz[i]!;
    const d = qw[i]!;
    // Twice over its length squared, which is 2 for a quaternion of
    // length 1: one of any other length draws as the turn it stands
    // for, and not skewed. All zeros is no turn at all.
    const n = a * a + b * b + c * c + d * d;
    const s = n > 0 ? 2 / n : 0;
    const a2 = a * s;
    const b2 = b * s;
    const c2 = c * s;
    const u = sx[i]!;
    const v = sy[i]!;
    const w = sz[i]!;
    out[at] = (1 - (b * b2 + c * c2)) * u;
    out[at + 1] = (a * b2 + d * c2) * u;
    out[at + 2] = (a * c2 - d * b2) * u;
    out[at + 3] = 0;
    out[at + 4] = (a * b2 - d * c2) * v;
    out[at + 5] = (1 - (a * a2 + c * c2)) * v;
    out[at + 6] = (b * c2 + d * a2) * v;
    out[at + 7] = 0;
    out[at + 8] = (a * c2 + d * b2) * w;
    out[at + 9] = (b * c2 - d * a2) * w;
    out[at + 10] = (1 - (a * a2 + b * b2)) * w;
    out[at + 11] = 0;
    out[at + 12] = x[i]!;
    out[at + 13] = y[i]!;
    out[at + 14] = z[i]!;
    out[at + 15] = 1;
    at += 16;
  }
};

// A flat game's entities, for a kind of Transform2d: in the plane of x and
// y, turned about the axis that comes out of it. The same four loops, with
// fewer columns.

/**
 * 2D entities with only a position.
 *
 * @internal
 */
export const placedFlat = (
  out: Float32Array,
  at: number,
  start: number,
  end: number,
  position: Xy
): void => {
  const { x, y } = position;
  for (let i = start; i < end; i++) {
    out[at] = 1;
    out[at + 1] = 0;
    out[at + 2] = 0;
    out[at + 3] = 0;
    out[at + 4] = 0;
    out[at + 5] = 1;
    out[at + 6] = 0;
    out[at + 7] = 0;
    out[at + 8] = 0;
    out[at + 9] = 0;
    out[at + 10] = 1;
    out[at + 11] = 0;
    out[at + 12] = x[i]!;
    out[at + 13] = y[i]!;
    out[at + 14] = 0;
    out[at + 15] = 1;
    at += 16;
  }
};

/**
 * 2D entities with a position and a scale.
 *
 * @internal
 */
export const sizedFlat = (
  out: Float32Array,
  at: number,
  start: number,
  end: number,
  position: Xy,
  scale: Xy
): void => {
  const { x, y } = position;
  const { x: sx, y: sy } = scale;
  for (let i = start; i < end; i++) {
    out[at] = sx[i]!;
    out[at + 1] = 0;
    out[at + 2] = 0;
    out[at + 3] = 0;
    out[at + 4] = 0;
    out[at + 5] = sy[i]!;
    out[at + 6] = 0;
    out[at + 7] = 0;
    out[at + 8] = 0;
    out[at + 9] = 0;
    out[at + 10] = 1;
    out[at + 11] = 0;
    out[at + 12] = x[i]!;
    out[at + 13] = y[i]!;
    out[at + 14] = 0;
    out[at + 15] = 1;
    at += 16;
  }
};

/**
 * Rotated 2D entities: a sine and a cosine each.
 *
 * @internal
 */
export const turnedFlat = (
  out: Float32Array,
  at: number,
  start: number,
  end: number,
  position: Xy,
  rotation: Angle
): void => {
  const { x, y } = position;
  const { angle } = rotation;
  for (let i = start; i < end; i++) {
    const cos = Math.cos(angle[i]!);
    const sin = Math.sin(angle[i]!);
    out[at] = cos;
    out[at + 1] = sin;
    out[at + 2] = 0;
    out[at + 3] = 0;
    out[at + 4] = -sin;
    out[at + 5] = cos;
    out[at + 6] = 0;
    out[at + 7] = 0;
    out[at + 8] = 0;
    out[at + 9] = 0;
    out[at + 10] = 1;
    out[at + 11] = 0;
    out[at + 12] = x[i]!;
    out[at + 13] = y[i]!;
    out[at + 14] = 0;
    out[at + 15] = 1;
    at += 16;
  }
};

/**
 * 2D entities with all three.
 *
 * @internal
 */
export const wholeFlat = (
  out: Float32Array,
  at: number,
  start: number,
  end: number,
  position: Xy,
  rotation: Angle,
  scale: Xy
): void => {
  const { x, y } = position;
  const { angle } = rotation;
  const { x: sx, y: sy } = scale;
  for (let i = start; i < end; i++) {
    const cos = Math.cos(angle[i]!);
    const sin = Math.sin(angle[i]!);
    const u = sx[i]!;
    const v = sy[i]!;
    out[at] = cos * u;
    out[at + 1] = sin * u;
    out[at + 2] = 0;
    out[at + 3] = 0;
    out[at + 4] = -sin * v;
    out[at + 5] = cos * v;
    out[at + 6] = 0;
    out[at + 7] = 0;
    out[at + 8] = 0;
    out[at + 9] = 0;
    out[at + 10] = 1;
    out[at + 11] = 0;
    out[at + 12] = x[i]!;
    out[at + 13] = y[i]!;
    out[at + 14] = 0;
    out[at + 15] = 1;
    at += 16;
  }
};
