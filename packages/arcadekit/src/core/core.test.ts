import { describe, expect, expectTypeOf, it } from "vitest";

import {
  EventBuffer,
  FixedStepClock,
  SpatialGrid,
  countDown,
  createIdentifiedPool,
  createPool,
  easeIn,
  easeOut,
  easeOutCubic,
  makeRng,
  progress,
  smoothstep,
  takeWhole,
} from "./index";
import type { Rng } from "./index";

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

/** The draw a generator makes after `draws` earlier ones. */
const drawAfter = (seed: number, draws: number): number => {
  const rng = makeRng(seed);
  for (let i = 0; i < draws; i++) {
    rng.next();
  }
  return rng.next();
};

/**
 * Picks from what a pick can't reorder: each is a type error. A list a game shares between
 * runs, such as its content, is `readonly`, and a game picks from a copy of it.
 */
const pickMistyped = (rng: Rng) => {
  const content: readonly string[] = ["boost", "magnet", "shield"];
  const fixed = ["boost", "magnet", "shield"] as const;
  return [
    // @ts-expect-error -- a readonly array can't be reordered in place.
    rng.pickDistinct(content, 2),
    // @ts-expect-error -- nor can a readonly tuple.
    rng.pickDistinct(fixed, 2),
    // @ts-expect-error -- nor can a string.
    rng.pickDistinct("abc", 0),
    // @ts-expect-error -- a DataView is over a buffer, and has no items.
    rng.pickDistinct(new DataView(new ArrayBuffer(8)), 0),
  ];
};

describe("Rng.pickDistinct", () => {
  it("draws exactly `count` times, or once for each item if there are fewer", () => {
    for (const [length, count, draws] of [
      [10, 3, 3],
      [10, 0, 0],
      // The last pick has one item left to draw from, and still draws: `int(1)`.
      [4, 4, 4],
      [2, 5, 2],
      [0, 3, 0],
    ] as const) {
      const rng = makeRng(7);
      const items = Array.from({ length }, (_, i) => i);
      expect(rng.pickDistinct(items, count)).toBe(draws);
      // The generator is where `draws` draws leave it: no more, no fewer.
      expect(rng.next()).toBe(drawAfter(7, draws));
    }
  });

  it("leaves a permutation of the items, the picks at the front", () => {
    const rng = makeRng(42);
    const items = ["a", "b", "c", "d", "e", "f", "g"];
    const count = rng.pickDistinct(items, 3);
    expect(count).toBe(3);
    expect(items.toSorted()).toStrictEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(new Set(items.slice(0, count)).size).toBe(3);
  });

  it("swaps item i with the one drawn at i + int(length - i), for each pick in turn", () => {
    // The contract every later draw of a run follows from: the same draws, in the same order.
    const rng = makeRng(2026);
    const twin = makeRng(2026);
    const items = [10, 20, 30, 40, 50, 60];
    const expected = [...items];
    for (let i = 0; i < 4; i++) {
      const j = i + twin.int(expected.length - i);
      [expected[i], expected[j]] = [expected[j]!, expected[i]!];
    }
    rng.pickDistinct(items, 4);
    expect(items).toStrictEqual(expected);
    // Not left in order by accident: a pick that swapped nothing would pass the line above.
    expect(items).not.toStrictEqual([10, 20, 30, 40, 50, 60]);
  });

  it("picks every item about as often", () => {
    const rng = makeRng(5);
    const picked = [0, 0, 0, 0, 0];
    for (let run = 0; run < 5000; run++) {
      const items = [0, 1, 2, 3, 4];
      const count = rng.pickDistinct(items, 2);
      for (let i = 0; i < count; i++) {
        picked[items[i]!]! += 1;
      }
    }
    // 10,000 picks over 5 items: 2,000 each, give or take.
    expect(Math.min(...picked)).toBeGreaterThan(1850);
    expect(Math.max(...picked)).toBeLessThan(2150);
  });

  it("takes a typed array, so a pick of pool indices allocates nothing", () => {
    const rng = makeRng(3);
    const twin = makeRng(3);
    const indices = new Uint16Array([5, 6, 7, 8, 9]);
    const asArray = [5, 6, 7, 8, 9];
    const count = rng.pickDistinct(indices, 2);
    expectTypeOf(count).toEqualTypeOf<number>();
    expect(count).toBe(twin.pickDistinct(asArray, 2));
    expect([...indices]).toStrictEqual(asArray);
    expect([...indices].toSorted()).toStrictEqual([5, 6, 7, 8, 9]);
  });

  it("refuses, as a type error, a list it can't reorder", () => {
    // Nothing checks it at run time: past the types, by a cast, a pick reorders a list its
    // owner calls readonly.
    expect(() => pickMistyped(makeRng(3))).not.toThrow();
  });

  it("refuses a count that is not a whole number of 0 or more, before it draws", () => {
    for (const count of [-1, 2.5, 0.5, Number.NaN, Infinity]) {
      const rng = makeRng(7);
      const items = ["a", "b", "c", "d"];
      expect(() => rng.pickDistinct(items, count)).toThrow(
        new RangeError(
          `pickDistinct needs a whole count of 0 or more, got ${count}`
        )
      );
      // Nothing was drawn and nothing moved, so a refused pick leaves the run as it was.
      expect(items).toStrictEqual(["a", "b", "c", "d"]);
      expect(rng.next()).toBe(drawAfter(7, 0));
    }
  });
});

describe(countDown, () => {
  it("lowers a timer, and stops at 0", () => {
    expect(countDown(0.5, 0.125)).toBe(0.375);
    expect(countDown(0.125, 0.125)).toBe(0);
    expect(countDown(0.1, 0.125)).toBe(0);
    expect(countDown(0, 0.125)).toBe(0);
    // Ready is +0, whatever the subtraction left.
    expect(Object.is(countDown(-0, 0), 0)).toBe(true);
  });

  it("is Math.max(0, value - by), bit for bit", () => {
    const dt = 1 / 60;
    let timer = 0.15;
    let written = 0.15;
    for (let step = 0; step < 12; step++) {
      timer = countDown(timer, dt);
      written = Math.max(0, written - dt);
      expect(timer).toBe(written);
    }
    expect(timer).toBe(0);
  });
});

describe(takeWhole, () => {
  it("gives 0 below 1, and for NaN", () => {
    expect(
      [0, 0.999, -3.5, -Infinity, Number.NaN].map(takeWhole)
    ).toStrictEqual([0, 0, 0, 0, 0]);
  });

  it("gives the whole units from 1 up", () => {
    expect([1, 1.999, 7.25, 600].map(takeWhole)).toStrictEqual([1, 1, 7, 600]);
  });

  it("leaves the same budget, bit for bit, as subtracting 1 in a loop", () => {
    // A rate of 13.7 a second at 60 steps a second, as a step spawns from it.
    let budget = 0;
    let looped = 0;
    let taken = 0;
    let loopedTaken = 0;
    for (let step = 0; step < 600; step++) {
      // Every 100th step is a burst, so some steps take several at once.
      const added = step % 100 === 99 ? 5.3 : 13.7 / 60;
      budget += added;
      const due = takeWhole(budget);
      budget -= due;
      taken += due;
      looped += added;
      while (looped >= 1) {
        looped -= 1;
        loopedTaken += 1;
      }
      expect(budget).toBe(looped);
    }
    expect(taken).toBe(loopedTaken);
    expect(taken).toBeGreaterThan(150);
  });
});

describe(progress, () => {
  it("goes from 0 at `startedAt` to 1 at `startedAt + duration`", () => {
    expect(progress(10, 10, 4)).toBe(0);
    expect(progress(11, 10, 4)).toBe(0.25);
    expect(progress(13, 10, 4)).toBe(0.75);
    expect(progress(14, 10, 4)).toBe(1);
  });

  it("stays at 0 before `startedAt` and at 1 after the end", () => {
    expect(progress(9, 10, 4)).toBe(0);
    expect(progress(-1000, 10, 4)).toBe(0);
    expect(progress(15, 10, 4)).toBe(1);
    expect(progress(Infinity, 10, 4)).toBe(1);
  });

  it("is 1 for a `startedAt` of -Infinity: what never started is done", () => {
    expect(progress(0, -Infinity, 0.09)).toBe(1);
    expect(progress(123.4, -Infinity, 0.09)).toBe(1);
  });

  it("is 1 for a `duration` of 0, and divides nothing", () => {
    expect(progress(10, 10, 0)).toBe(1);
    expect(progress(11, 10, 0)).toBe(1);
    expect(progress(9, 10, 0)).toBe(0);
  });
});

describe("the eases", () => {
  it.each([
    ["easeIn", easeIn],
    ["easeOut", easeOut],
    ["easeOutCubic", easeOutCubic],
    ["smoothstep", smoothstep],
  ] as const)(
    "%s gives 0 at 0 and 1 at 1, and rises between",
    (_name, ease) => {
      expect(ease(0)).toBe(0);
      expect(ease(1)).toBe(1);
      let last = 0;
      for (let i = 1; i <= 16; i++) {
        const eased = ease(i / 16);
        expect(eased).toBeGreaterThan(last);
        last = eased;
      }
    }
  );

  it("are the polynomials their names say", () => {
    // t * t, t * (2 - t), 1 - (1 - t)^3 and t * t * (3 - 2 * t): exact at these points.
    expect(easeIn(0.25)).toBe(0.0625);
    expect(easeOut(0.25)).toBe(0.4375);
    expect(easeOutCubic(0.5)).toBe(0.875);
    expect(smoothstep(0.25)).toBe(0.15625);
  });

  it("are their expressions, bit for bit", () => {
    // A step may call an ease, so the order of its operations is fixed. Each is pinned where
    // another way to write the same polynomial gives other bits.
    expect(easeIn(0.1)).toBe(0.010000000000000002);
    expect(easeOut(0.9)).toBe(0.9900000000000001);
    expect(easeOutCubic(0.1)).toBe(0.2709999999999999);
    expect([smoothstep(0.1), smoothstep(0.3)]).toStrictEqual([
      0.028000000000000004, 0.216,
    ]);
    // The other ways: easeOut as 1 - (1 - t)^2 and as 2t - t^2, easeOutCubic expanded, and
    // smoothstep with its products regrouped at 0.1, then expanded at 0.3.
    expect([
      1 - (1 - 0.9) * (1 - 0.9),
      2 * 0.9 - 0.9 * 0.9,
      0.1 * (3 - 3 * 0.1 + 0.1 * 0.1),
      0.1 * (0.1 * (3 - 2 * 0.1)),
      3 * 0.3 * 0.3 - 2 * 0.3 * 0.3 * 0.3,
    ]).toStrictEqual([
      0.99, 0.99, 0.271, 0.027999999999999997, 0.21599999999999997,
    ]);
  });

  it("start slow, end slow, or both", () => {
    expect(easeIn(0.5)).toBeLessThan(0.5);
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
    expect(easeOutCubic(0.5)).toBeGreaterThan(easeOut(0.5));
    expect(smoothstep(0.5)).toBe(0.5);
  });

  it("smoothstep clamps", () => {
    expect([-0.5, -Infinity, 1.5, Infinity].map(smoothstep)).toStrictEqual([
      0, 0, 1, 1,
    ]);
  });

  it("the others don't clamp: a caller passes them a progress", () => {
    expect([easeIn(2), easeOut(2), easeOutCubic(2)]).toStrictEqual([4, 0, 2]);
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
