import { describe, expect, it } from "vitest";

import {
  EventBuffer,
  FixedStepClock,
  SpatialGrid,
  createIdentifiedPool,
  createPool,
  makeRng,
} from "./index";

describe(makeRng, () => {
  it("repeats for the same seed and differs for another", () => {
    const a = makeRng(1);
    const b = makeRng(1);
    const c = makeRng(2);
    const seqA = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toStrictEqual(seqA);
    expect(Array.from({ length: 5 }, () => c.next())).not.toStrictEqual(seqA);
    expect(seqA.every((v) => v >= 0 && v < 1)).toBe(true);
  });
});

describe(createPool, () => {
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
    expect([...pool.fields.id.subarray(0, pool.count)]).toStrictEqual([30, 20]);
    expect(pool.fields.x[0]).toBe(3);
    pool.clear();
    expect(pool.count).toBe(0);
  });
});

const filled = () => {
  const pool = createIdentifiedPool(4, { x: Float32Array });
  for (const x of [10, 20, 30]) {
    pool.fields.x[pool.add()] = x;
  }
  return pool;
};
/** Each live entity as [id, x], in index order. */
const entries = (pool: ReturnType<typeof filled>) =>
  Array.from({ length: pool.count }, (_, i) => [
    pool.idOf(i),
    pool.fields.x[i],
  ]);

describe(createIdentifiedPool, () => {
  it("hands out ids 0, 1, 2… and finds each entity by id", () => {
    const pool = filled();
    expect(entries(pool)).toStrictEqual([
      [0, 10],
      [1, 20],
      [2, 30],
    ]);
    expect(pool.indexOf(1)).toBe(1);
    expect(pool.indexOf(3)).toBe(-1);
    expect(pool.indexOf(-1)).toBe(-1);
  });

  it("keeps every id with its entity when another is removed", () => {
    const pool = filled();
    pool.remove(0);
    expect(entries(pool)).toStrictEqual([
      [2, 30],
      [1, 20],
    ]);
    expect(pool.indexOf(0)).toBe(-1);
    expect(pool.fields.x[pool.indexOf(2)]).toBe(30);
  });

  it("brings a removed entity back under its old id", () => {
    const pool = filled();
    pool.remove(pool.indexOf(1));
    const i = pool.addWithId(1);
    pool.fields.x[i] = 20;
    expect(pool.indexOf(1)).toBe(i);
    expect(pool.count).toBe(3);
    // The other free id is the one `add` hands out next.
    expect(pool.idOf(pool.add())).toBe(3);
  });

  it("refuses an id that is in use, and any id when full", () => {
    const pool = filled();
    expect(pool.addWithId(0)).toBe(-1);
    expect(pool.addWithId(4)).toBe(-1);
    pool.add();
    expect(pool.addWithId(3)).toBe(-1);
  });

  it("starts again from id 0 after clear", () => {
    const pool = filled();
    pool.remove(1);
    pool.clear();
    expect(pool.idOf(pool.add())).toBe(0);
    expect(pool.idOf(pool.add())).toBe(1);
  });
});

describe(SpatialGrid, () => {
  it("finds nearby points and skips distant ones", () => {
    const grid = new SpatialGrid({ halfSize: 10, cellSize: 2, capacity: 3 });
    const xs = new Float32Array([0, 0.5, 9]);
    const ys = new Float32Array([0, 0.5, 9]);
    grid.build(xs, ys, 3);
    const out = new Int32Array(8);
    const found = [...out.subarray(0, grid.query(0, 0, 1, out))].toSorted();
    expect(found).toStrictEqual([0, 1]);
  });
});

describe(FixedStepClock, () => {
  it("runs whole steps and carries the remainder", () => {
    // Powers of two, so the sums are exact in floating point.
    const clock = new FixedStepClock(0.125, 5);
    let steps = 0;
    const count = () => {
      steps += 1;
    };
    expect(clock.advance(0.3125, count)).toBe(2);
    expect(clock.advance(0.0625, count)).toBe(1);
    expect(steps).toBe(3);
  });

  it("drops the backlog after a very long frame", () => {
    const clock = new FixedStepClock(0.1, 5);
    expect(clock.advance(10, () => {})).toBe(5);
    // Nothing carried over: half a step owes none.
    expect(clock.advance(0.05, () => {})).toBe(0);
  });
});

describe(EventBuffer, () => {
  it("drains in order and empties", () => {
    const events = new EventBuffer<string>();
    events.push("a");
    events.push("b");
    expect(events.drain()).toStrictEqual(["a", "b"]);
    expect(events.drain()).toStrictEqual([]);
  });
});
