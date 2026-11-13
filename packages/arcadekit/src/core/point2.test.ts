import { describe, expect, it } from "vitest";

import { ExactMath, Point2 } from "./index";

// A point's functions write two numbers a step reads back (ADR-0011). A run's hashes depend on
// the order of their operations, so the bits are pinned where another order gives other bits.

describe("Point2.clampLength", () => {
  it("leaves a vector no longer than `max` as it is, and returns its length", () => {
    const out = Point2.make(9, 9);
    expect(Point2.clampLength(out, 0.3, -0.4, 1)).toBe(0.5);
    expect([out.x, out.y]).toStrictEqual([0.3, -0.4]);
  });

  it("leaves a vector exactly `max` long as it is: that is not longer", () => {
    const out = Point2.make(9, 9);
    expect(Point2.clampLength(out, 3, 4, 5)).toBe(5);
    expect([out.x, out.y]).toStrictEqual([3, 4]);
    // Here shortening the vector to its own length would move x's last bit.
    const length = ExactMath.hypot2(0.2, -0.7);
    expect((0.2 / length) * length).toBe(0.20000000000000004);
    expect(Point2.clampLength(out, 0.2, -0.7, length)).toBe(length);
    expect([out.x, out.y]).toStrictEqual([0.2, -0.7]);
  });

  it("leaves no move as no move, whatever `max` is", () => {
    const out = Point2.make(9, 9);
    // A `max` below 0 is a mistake, and still divides nothing by a length of 0.
    for (const max of [1, 0, -1, Number.NaN]) {
      out.x = 9;
      out.y = 9;
      expect(Point2.clampLength(out, 0, 0, max)).toBe(0);
      expect([out.x, out.y]).toStrictEqual([0, 0]);
    }
  });

  it("shortens a longer vector to `max`, and returns the length it had", () => {
    const out = Point2.make(9, 9);
    expect(Point2.clampLength(out, 0, -8, 2)).toBe(8);
    expect([out.x, out.y]).toStrictEqual([0, -2]);
    expect(Point2.clampLength(out, 6, 8, 5)).toBe(10);
    expect(out.x).toBeCloseTo(3, 12);
    expect(out.y).toBeCloseTo(4, 12);
  });

  it("gives x / length, bit for bit, at a `max` of 1", () => {
    // What a step did before it called this: `x /= length`. A run's hashes depend on it.
    const out = Point2.make(0, 0);
    for (const [x, y] of [
      [0.7, 0.9],
      [-1, 1],
      [1.0001, 0],
      [-3.3, -0.1],
      [1e-3, 1e3],
    ] as const) {
      const length = ExactMath.hypot2(x, y);
      expect(length).toBeGreaterThan(1);
      expect(Point2.clampLength(out, x, y, 1)).toBe(length);
      expect([out.x, out.y]).toStrictEqual([x / length, y / length]);
    }
    expect(Point2.clampLength(out, 0.7, 0.9, 1)).toBe(1.140175425099138);
    expect([out.x, out.y]).toStrictEqual([
      0.6139406135149204, 0.7893522173763262,
    ]);
  });

  it("is (x / length) * max, bit for bit, at any other `max`", () => {
    // A run's hashes depend on the order of these operations, so the bits are pinned where
    // the other orders give other bits.
    const out = Point2.make(0, 0);
    Point2.clampLength(out, 3.3, -0.1, 2.5);
    expect([out.x, out.y]).toStrictEqual([
      2.4988529478634534, -0.07572281660192284,
    ]);
    // (y * max) / length moves y's last bit there.
    expect((-0.1 * 2.5) / ExactMath.hypot2(3.3, -0.1)).toBe(
      -0.07572281660192283
    );
    Point2.clampLength(out, 0.7, 0.9, 0.5);
    expect([out.x, out.y]).toStrictEqual([
      0.3069703067574602, 0.3946761086881631,
    ]);
    // And y * (max / length) moves it here.
    expect(0.9 * (0.5 / ExactMath.hypot2(0.7, 0.9))).toBe(0.39467610868816316);
  });

  it("is the same expression on x as on y", () => {
    // The two vectors above with their axes swapped, so x is pinned as y is.
    const out = Point2.make(0, 0);
    Point2.clampLength(out, -0.1, 3.3, 2.5);
    expect([out.x, out.y]).toStrictEqual([
      -0.07572281660192284, 2.4988529478634534,
    ]);
    Point2.clampLength(out, 0.9, 0.7, 0.5);
    expect([out.x, out.y]).toStrictEqual([
      0.3946761086881631, 0.3069703067574602,
    ]);
  });
});

describe("Point2.moveToward", () => {
  it("lands on a target within `maxStep`", () => {
    const out = Point2.make(9, 9);
    Point2.moveToward(out, 1, 1, 4, 5, 6);
    expect([out.x, out.y]).toStrictEqual([4, 5]);
    // Exactly `maxStep` away is within it.
    Point2.moveToward(out, 1, 1, 4, 5, 5);
    expect([out.x, out.y]).toStrictEqual([4, 5]);
    // So is this one, where going its whole distance toward it would miss x by its last bit.
    const distance = ExactMath.hypot2(0.2, -0.7);
    expect((0.2 / distance) * distance).toBe(0.20000000000000004);
    Point2.moveToward(out, 0, 0, 0.2, -0.7, distance);
    expect([out.x, out.y]).toStrictEqual([0.2, -0.7]);
  });

  it("stays on a target it is already on, whatever `maxStep` is", () => {
    const out = Point2.make(9, 9);
    // A `maxStep` below 0 is a mistake, and still divides nothing by a distance of 0.
    for (const maxStep of [0, 0.3, -0.1, Number.NaN]) {
      out.x = 9;
      out.y = 9;
      Point2.moveToward(out, 2, -2, 2, -2, maxStep);
      expect([out.x, out.y]).toStrictEqual([2, -2]);
    }
  });

  it("goes `maxStep` toward a target beyond it", () => {
    const out = Point2.make(9, 9);
    Point2.moveToward(out, 1, 1, 4, 5, 2.5);
    expect([out.x, out.y]).toStrictEqual([2.5, 3]);
    Point2.moveToward(out, 0, 0, -10, 0, 0.25);
    expect([out.x, out.y]).toStrictEqual([-0.25, 0]);
  });

  it("is x + (dx / distance) * maxStep, bit for bit", () => {
    // A run's hashes depend on the order of these operations, so the bits are pinned where
    // the other orders give other bits.
    const out = Point2.make(0, 0);
    Point2.moveToward(out, 0.2, 0.4, 5.3, 3.9, 0.7);
    expect([out.x, out.y]).toStrictEqual([
      0.7771593468506621, 0.7960897478386899,
    ]);
    const dx = 5.3 - 0.2;
    const dy = 3.9 - 0.4;
    const distance = ExactMath.hypot2(dx, dy);
    // dx * (maxStep / distance) moves x's last bit, and (dy * maxStep) / distance moves y's.
    expect(0.2 + dx * (0.7 / distance)).toBe(0.7771593468506623);
    expect(0.4 + (dy * 0.7) / distance).toBe(0.7960897478386898);
    // The same with the axes swapped, so each axis is pinned against both.
    Point2.moveToward(out, 0.4, 0.2, 3.9, 5.3, 0.7);
    expect([out.x, out.y]).toStrictEqual([
      0.7960897478386899, 0.7771593468506621,
    ]);
  });
});
