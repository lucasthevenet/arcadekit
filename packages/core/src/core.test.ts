import { describe, expect, it } from "vitest";

import {
  EventBuffer,
  FixedStepClock,
  SpatialGrid,
  createPool,
  makeRng,
} from "./index";

describe("makeRng", () => {
  it("repeats for the same seed and differs for another", () => {
    const a = makeRng(1);
    const b = makeRng(1);
    const c = makeRng(2);
    const seqA = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(seqA);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(seqA);
    expect(seqA.every((v) => v >= 0 && v < 1)).toBe(true);
  });
});

describe("createPool", () => {
  it("packs entities and swaps the last one into removed slots", () => {
    const pool = createPool(3, { x: Float32Array, id: Uint16Array });
    for (const id of [10, 20, 30]) {
      const i = pool.add();
      pool.fields.x[i] = id / 10;
      pool.fields.id[i] = id;
    }
    expect(pool.add()).toBe(-1);
    pool.remove(0);
    expect(pool.count).toBe(2);
    expect(Array.from(pool.fields.id.subarray(0, pool.count))).toEqual([
      30, 20,
    ]);
    expect(pool.fields.x[0]).toBe(3);
    pool.clear();
    expect(pool.count).toBe(0);
  });
});

describe("SpatialGrid", () => {
  it("finds nearby points and skips distant ones", () => {
    const grid = new SpatialGrid({ halfSize: 10, cellSize: 2, capacity: 3 });
    const xs = new Float32Array([0, 0.5, 9]);
    const ys = new Float32Array([0, 0.5, 9]);
    grid.build(xs, ys, 3);
    const out = new Int32Array(8);
    const found = Array.from(out.subarray(0, grid.query(0, 0, 1, out))).sort();
    expect(found).toEqual([0, 1]);
  });
});

describe("FixedStepClock", () => {
  it("runs whole steps and carries the remainder", () => {
    // Powers of two, so the sums are exact in floating point.
    const clock = new FixedStepClock(0.125, 5);
    let steps = 0;
    expect(clock.advance(0.3125, () => steps++)).toBe(2);
    expect(clock.alpha).toBe(0.5);
    expect(clock.advance(0.0625, () => steps++)).toBe(1);
    expect(steps).toBe(3);
  });

  it("drops the backlog after a very long frame", () => {
    const clock = new FixedStepClock(0.1, 5);
    expect(clock.advance(10, () => {})).toBe(5);
    expect(clock.alpha).toBe(0);
  });
});

describe("EventBuffer", () => {
  it("drains in order and empties", () => {
    const events = new EventBuffer<string>();
    events.push("a");
    events.push("b");
    expect(events.drain()).toEqual(["a", "b"]);
    expect(events.drain()).toEqual([]);
  });
});
