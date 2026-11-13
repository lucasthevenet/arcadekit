import { describe, expect, expectTypeOf, it } from "vitest";

import {
  EventBuffer,
  FixedStepClock,
  SpatialGrid,
  StateHasher,
  countDown,
  createIdentifiedPool,
  createPool,
  easeIn,
  easeOut,
  easeOutCubic,
  hypot2,
  makeRng,
  progress,
  smoothstep,
  takeWhole,
  visitPool,
} from "./index";
import type { Pool, PoolLayout, Rng } from "./index";

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

  it("gives a slot whose fields are all 0, whatever its last entity left", () => {
    const pool = createPool(3, { x: Float32Array, id: Uint16Array });
    /** Adds an entity and reads its fields before anything writes them. */
    const added = () => {
      const i = pool.add();
      return [i, pool.fields.x[i], pool.fields.id[i]];
    };
    const fill = (x: number, id: number) => {
      const i = pool.add();
      pool.fields.x[i] = x;
      pool.fields.id[i] = id;
    };
    fill(1.5, 10);
    fill(2.5, 20);
    fill(3.5, 30);
    // Removing the first moves the last into it, and leaves the last slot as it was.
    pool.remove(0);
    expect([pool.fields.x[2], pool.fields.id[2]]).toStrictEqual([3.5, 30]);
    expect(added()).toStrictEqual([2, 0, 0]);
    // The entities beside it keep theirs.
    expect([...pool.fields.id.subarray(0, 2)]).toStrictEqual([30, 20]);

    pool.fields.x[2] = 4.5;
    pool.fields.id[2] = 40;
    pool.clear();
    // `clear` only forgets the count: each slot is cleaned as `add` hands it out.
    expect([...pool.fields.id]).toStrictEqual([30, 20, 40]);
    expect([added(), added(), added()]).toStrictEqual([
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ]);
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

  it("gives a slot whose fields are all 0 from add and from addWithId", () => {
    const pool = createIdentifiedPool(4, { x: Float32Array, hp: Uint8Array });
    for (const x of [10, 20, 30]) {
      const i = pool.add();
      pool.fields.x[i] = x;
      pool.fields.hp[i] = x / 10;
    }
    // The last entity, id 2, leaves its values in slot 2.
    pool.remove(2);
    expect([pool.fields.x[2], pool.fields.hp[2]]).toStrictEqual([30, 3]);
    const back = pool.addWithId(2);
    expect([back, pool.fields.x[back], pool.fields.hp[back]]).toStrictEqual([
      2, 0, 0,
    ]);

    pool.fields.x[back] = 30;
    pool.fields.hp[back] = 3;
    pool.remove(pool.indexOf(2));
    const next = pool.add();
    expect([next, pool.fields.x[next], pool.fields.hp[next]]).toStrictEqual([
      2, 0, 0,
    ]);

    pool.fields.x[next] = 40;
    pool.clear();
    expect([...pool.fields.x]).toStrictEqual([10, 20, 40, 0]);
    // Id 1 is free again after the clear, and its slot is the first one handed out.
    const first = pool.addWithId(1);
    expect([first, pool.fields.x[first], pool.fields.hp[first]]).toStrictEqual([
      0, 0, 0,
    ]);
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

const OFFSET_BASIS = 0x81_1c_9d_c5;

/** The digest of `values`, folded in order by a hasher of their own. */
const digestOf = (...values: number[]): number => {
  const hasher = new StateHasher();
  for (const value of values) {
    hasher.number(value);
  }
  return hasher.digest();
};

/** A list as a game writes one: a function that takes the `add` of whoever folds it. */
const visitOneTwo = (add: (value: number) => void) => {
  add(1);
  add(2);
};

describe(StateHasher, () => {
  it("gives FNV-1a's offset basis with nothing folded in", () => {
    expect(new StateHasher().digest()).toBe(OFFSET_BASIS);
  });

  it("pins the digest of a short list: FNV-1a over each number's eight float64 bytes", () => {
    // Recorded from an FNV-1a written apart from this one, over the little-endian bytes of each
    // float64. A change to the fold moves every hash a game has recorded.
    expect([
      digestOf(1, -2.5, 0.1, 1e300),
      digestOf(1, 2),
      digestOf(2, 1),
    ]).toStrictEqual([88_484_247, 1_170_904_120, 3_930_474_840]);
  });

  it("shows a change in one bit: 0 and -0 have different digests", () => {
    expect([digestOf(0), digestOf(-0)]).toStrictEqual([
      2_615_243_109, 467_811_045,
    ]);
  });

  it("gives every NaN one digest, whatever bits the engine holds it in", () => {
    // Three NaNs an engine may store with different bits: the literal, one a division makes, and
    // one read from bytes that have the sign bit and a payload bit set.
    const zero = Number("0");
    const divided = zero / zero;
    const read = new Float64Array(
      Uint8Array.of(1, 0, 0, 0, 0, 0, 0xf8, 0xff).buffer
    )[0]!;
    expect([divided, read]).toStrictEqual([Number.NaN, Number.NaN]);
    // Recorded as the other digests are, over the bytes 00 00 00 00 00 00 f8 7f.
    expect([
      digestOf(Number.NaN),
      digestOf(divided),
      digestOf(read),
      digestOf(1, read, 2),
    ]).toStrictEqual([
      3_428_180_608, 3_428_180_608, 3_428_180_608, 4_198_234_637,
    ]);
  });

  it("starts again on reset, and gives the same digest for the same numbers", () => {
    const hasher = new StateHasher();
    const first = hasher.number(3).number(0.25).digest();
    expect(first).not.toBe(OFFSET_BASIS);
    expect(hasher.reset().digest()).toBe(OFFSET_BASIS);
    expect(hasher.number(3).number(0.25).digest()).toBe(first);
    // Without the reset, the second fold goes on from the first.
    expect(hasher.number(3).number(0.25).digest()).not.toBe(first);
  });

  it("folds through `number` on its own, as the `add` a game's list takes", () => {
    const hasher = new StateHasher();
    visitOneTwo(hasher.number);
    expect(hasher.digest()).toBe(digestOf(1, 2));
  });
});

/** Everything `visitPool` passes to its `visit`, in order. */
const visited = <L extends PoolLayout>(pool: Pool<L>): number[] => {
  const values: number[] = [];
  visitPool(pool, (value) => {
    values.push(value);
  });
  return values;
};

describe(visitPool, () => {
  it("visits the count, then each field's live values in the layout's order, and nothing past the count", () => {
    const pool = createPool(4, { x: Float32Array, hp: Uint8Array });
    expect(visited(pool)).toStrictEqual([0]);
    for (const [x, hp] of [
      [1.5, 10],
      [2.5, 20],
      [3.5, 30],
    ] as const) {
      const i = pool.add();
      pool.fields.x[i] = x;
      pool.fields.hp[i] = hp;
    }
    expect(visited(pool)).toStrictEqual([3, 1.5, 2.5, 3.5, 10, 20, 30]);
    pool.remove(0);
    // Slot 2 still holds what moved into slot 0. It is past the count, so it is not visited.
    expect([pool.fields.x[2], pool.fields.hp[2]]).toStrictEqual([3.5, 30]);
    expect(visited(pool)).toStrictEqual([2, 3.5, 2.5, 30, 20]);
  });

  it("visits the fields `Object.values` lists, in its order", () => {
    // An object's keys that are whole numbers come first, in ascending order, whatever the order
    // they were written in. A hash recorded over a pool depends on this order.
    const pool = createPool(2, {
      z: Float32Array,
      10: Uint8Array,
      x: Float32Array,
      2: Uint8Array,
    });
    for (const [z, ten, x, two] of [
      [1.5, 10, 2.5, 20],
      [3.5, 30, 4.5, 40],
    ] as const) {
      const i = pool.add();
      pool.fields.z[i] = z;
      pool.fields[10][i] = ten;
      pool.fields.x[i] = x;
      pool.fields[2][i] = two;
    }
    expect(visited(pool)).toStrictEqual([
      2, 20, 40, 10, 30, 1.5, 3.5, 2.5, 4.5,
    ]);
    expect(visited(pool)).toStrictEqual([
      pool.count,
      ...Object.values(pool.fields).flatMap((array) => [...array]),
    ]);
  });

  it("visits an identified pool as a pool: no id is visited", () => {
    const pool = filled();
    pool.remove(0);
    // Ids 2 and 1 are live, in that order.
    expect(entries(pool)).toStrictEqual([
      [2, 30],
      [1, 20],
    ]);
    expect(visited(pool)).toStrictEqual([2, 30, 20]);
  });

  it("takes a hasher's `number` as its visit", () => {
    const pool = createPool(2, { x: Float32Array, hp: Uint8Array });
    const i = pool.add();
    pool.fields.x[i] = 1.5;
    pool.fields.hp[i] = 7;
    const hasher = new StateHasher();
    visitPool(pool, hasher.number);
    expect(hasher.digest()).toBe(digestOf(1, 1.5, 7));
  });
});

/** What a grid wrote into a buffer of `size`, as a list. */
const listed = (size: number, ask: (out: Int32Array) => number): number[] => {
  const out = new Int32Array(size);
  return [...out.subarray(0, ask(out))];
};

/** The nearest point as a loop over every point finds it: the first of the lowest length under `range`. */
const scanNearest = (
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  count: number,
  x: number,
  y: number,
  range: number,
  skip: ArrayLike<number>
): number => {
  let best = -1;
  let bestD = range;
  for (let i = 0; i < count; i++) {
    const d = hypot2(xs[i]! - x, ys[i]! - y);
    if (d < bestD && skip[i] === 0) {
      best = i;
      bestD = d;
    }
  }
  return best;
};

// Cells are 2 wide and cell 5 starts at 0, so a circle of radius 1 at the origin overlaps cells
// 4 and 5 on each axis: the points from -2 up to, but not at, 2.
const makeGrid = (capacity = 8) =>
  new SpatialGrid({ halfSize: 10, cellSize: 2, capacity });

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

  it("has no points before its first build", () => {
    const grid = makeGrid();
    const out = new Int32Array(4);
    expect([
      grid.query(0, 0, 1, out),
      grid.within(0, 0, 1, out),
      grid.nearest(0, 0, 100),
    ]).toStrictEqual([0, 0, -1]);
  });

  it("refuses a build of more points than its capacity, and keeps the build it had", () => {
    const grid = makeGrid(2);
    grid.build([0.5, 0.6], [0, 0], 2);
    // A third point has no place in the cells' lists: asked for it, the grid would never end.
    expect(() => grid.build([0.1, 0.2, 0.3], [0, 0, 0], 3)).toThrow(
      new RangeError(
        "SpatialGrid.build needs a count within the grid's capacity of 2, got 3"
      )
    );
    expect(listed(8, (out) => grid.query(0, 0, 1, out))).toStrictEqual([1, 0]);
    expect(listed(8, (out) => grid.within(0, 0, 1, out))).toStrictEqual([1, 0]);
    expect(grid.nearest(0, 0, 1)).toBe(0);
  });

  it("refuses a build with fewer radii than points, and keeps the build it had", () => {
    const grid = makeGrid();
    grid.build([0.5], [0], 1);
    expect(() => grid.build([0.1, 0.2, 0.3], [0, 0, 0], 3, [1, 1])).toThrow(
      new RangeError(
        "SpatialGrid.build needs a radius for each of its 3 points, got 2"
      )
    );
    expect(listed(8, (out) => grid.within(0, 0, 1, out))).toStrictEqual([0]);
    // More radii than points is a pool's field: the build reads its first `count`.
    grid.build([0.1, 0.2, 0.3], [0, 0, 0], 2, [1, 1, 1]);
    expect(listed(8, (out) => grid.within(0, 0, 1, out))).toStrictEqual([1, 0]);
  });

  describe("within", () => {
    it("leaves out a point that query returns for the same circle", () => {
      const grid = makeGrid();
      // Both are in the cell the circle is in. The second is 2.7 from the centre.
      grid.build([0.5, 1.9], [0.5, 1.9], 2);
      expect(listed(8, (out) => grid.query(0, 0, 1, out))).toStrictEqual([
        1, 0,
      ]);
      expect(listed(8, (out) => grid.within(0, 0, 1, out))).toStrictEqual([0]);
    });

    it("finds a wide point whose centre and cell are outside the circle's", () => {
      const grid = makeGrid();
      // The point is 5 from the centre, two cells past the circle's, with a radius of 4.5.
      grid.build([5, 9], [0, 9], 2, [4.5, 0.5]);
      expect(listed(8, (out) => grid.query(0, 0, 1, out))).toStrictEqual([]);
      expect(listed(8, (out) => grid.within(0, 0, 1, out))).toStrictEqual([0]);
    });

    it("leaves out a circle that only touches", () => {
      const grid = makeGrid();
      // Each is 5 from the centre, a 3-4-5 triangle, so the lengths are exact.
      const xs = [3, -3, 5];
      const ys = [4, 4, 0];
      grid.build(xs, ys, 3, [4, 4.25, 3.75]);
      // 5 is not under 1 + 4, and is under 1 + 4.25.
      expect(listed(8, (out) => grid.within(0, 0, 1, out))).toStrictEqual([1]);
      grid.build(xs, ys, 3);
      expect(listed(8, (out) => grid.within(0, 0, 5, out))).toStrictEqual([]);
      expect(
        listed(8, (out) => grid.within(0, 0, 5.25, out)).toSorted()
      ).toStrictEqual([0, 1, 2]);
    });

    it("returns the points in query's order: rows, then columns, then each cell's list", () => {
      const grid = makeGrid();
      // Four cells around the origin. Points 0, 3 and 5 share one, and 5 is too far.
      grid.build(
        [0.5, -0.5, 0.5, 0.6, -0.5, 1.9],
        [0.5, 0.5, -0.5, 0.6, -0.5, 1.9],
        6
      );
      expect(listed(8, (out) => grid.query(0, 0, 1, out))).toStrictEqual([
        4, 2, 1, 5, 3, 0,
      ]);
      expect(listed(8, (out) => grid.within(0, 0, 1, out))).toStrictEqual([
        4, 2, 1, 3, 0,
      ]);
    });

    it("gives the points a test of every candidate gives, in query's order", () => {
      const rng = makeRng(81);
      const count = 300;
      const grid = new SpatialGrid({
        halfSize: 10,
        cellSize: 2,
        capacity: count,
      });
      const xs = new Float32Array(count);
      const ys = new Float32Array(count);
      const radii = new Float64Array(count);
      // Some points are past the grid's edge, where they are kept in the edge cells.
      for (let i = 0; i < count; i++) {
        xs[i] = rng.range(-12, 12);
        ys[i] = rng.range(-12, 12);
        radii[i] = rng.range(0, 1.5);
      }
      grid.build(xs, ys, count, radii);
      const widest = Math.max(...radii);
      let hits = 0;
      for (let q = 0; q < 200; q++) {
        const x = rng.range(-12, 12);
        const y = rng.range(-12, 12);
        const radius = rng.range(0, 3);
        const expected = listed(count, (out) =>
          grid.query(x, y, radius + widest, out)
        ).filter((i) => hypot2(xs[i]! - x, ys[i]! - y) < radius + radii[i]!);
        const everyPoint = Array.from({ length: count }, (_, i) => i).filter(
          (i) => hypot2(xs[i]! - x, ys[i]! - y) < radius + radii[i]!
        );
        expect(
          listed(count, (out) => grid.within(x, y, radius, out))
        ).toStrictEqual(expected);
        expect(expected.toSorted((a, b) => a - b)).toStrictEqual(everyPoint);
        hits += expected.length;
      }
      // The circles must find something, or the loop proves little.
      expect(hits).toBeGreaterThan(200);
    });

    it("stops when out is full, and fills it with points that overlap", () => {
      const grid = makeGrid();
      // Point 0 comes first in the circle's cells, and is too far.
      grid.build([-1.9, 0.5, 0.6, 0.7], [-1.9, 0.5, 0.6, 0.7], 4);
      // How many each found, then what it wrote.
      const two = new Int32Array(2);
      expect([grid.query(0, 0, 1, two), ...two]).toStrictEqual([2, 0, 3]);
      expect([grid.within(0, 0, 1, two), ...two]).toStrictEqual([2, 3, 2]);
      const four = new Int32Array(4).fill(-1);
      expect([grid.within(0, 0, 1, four), ...four]).toStrictEqual([
        3, 3, 2, 1, -1,
      ]);
      expect(grid.within(0, 0, 1, new Int32Array(0))).toBe(0);
    });

    it("tests a point where it is now, and finds it from the cell it was built in", () => {
      const grid = makeGrid();
      const xs = new Float32Array([1.5]);
      const ys = new Float32Array([0]);
      grid.build(xs, ys, 1);
      expect(listed(8, (out) => grid.within(0, 0, 1, out))).toStrictEqual([]);
      xs[0] = 0.5;
      expect(listed(8, (out) => grid.within(0, 0, 1, out))).toStrictEqual([0]);
      // Across the grid: the origin's circle no longer overlaps it, and no circle over there
      // visits the cell it was built in.
      xs[0] = 9;
      expect(listed(8, (out) => grid.within(0, 0, 1, out))).toStrictEqual([]);
      expect(listed(8, (out) => grid.within(9, 0, 1, out))).toStrictEqual([]);
    });

    it("tests a radius as it is now, and looks no further for it than the build's widest", () => {
      const grid = makeGrid();
      const xs = [5, 0.5];
      const ys = [0, 0];
      const radii = [0.5, 0.5];
      grid.build(xs, ys, 2, radii);
      expect(listed(8, (out) => grid.within(0, 0, 1, out))).toStrictEqual([1]);
      // Raised to reach the origin's circle, 5 away. From there the cells visited are those of
      // 1 plus the build's 0.5, so the point's cell is not among them.
      radii[0] = 4.5;
      expect(listed(8, (out) => grid.within(0, 0, 1, out))).toStrictEqual([1]);
      // A circle that visits its cell tests it with the radius it has now: 1.5 away, under 1 + 4.5.
      expect(listed(8, (out) => grid.within(3.5, 0, 1, out))).toStrictEqual([
        0,
      ]);
      // Built again, the origin's circle finds it.
      grid.build(xs, ys, 2, radii);
      expect(
        listed(8, (out) => grid.within(0, 0, 1, out)).toSorted()
      ).toStrictEqual([0, 1]);
    });

    it("tests centres alone on a grid built without radii", () => {
      const grid = makeGrid();
      const xs = [3, 0.5];
      const ys = [0, 0];
      grid.build(xs, ys, 2, [2.5, 0]);
      expect(
        listed(8, (out) => grid.within(0, 0, 1, out)).toSorted()
      ).toStrictEqual([0, 1]);
      // The same points, built again with no radii: the first is a centre 3 away.
      grid.build(xs, ys, 2);
      expect(listed(8, (out) => grid.within(0, 0, 1, out))).toStrictEqual([1]);
      // And no cell past the circle's is visited for it: moved into the circle, it is not found.
      xs[0] = 0.5;
      expect(listed(8, (out) => grid.within(0, 0, 1, out))).toStrictEqual([1]);
      grid.build(xs, ys, 2);
      expect(
        listed(8, (out) => grid.within(0, 0, 1, out)).toSorted()
      ).toStrictEqual([0, 1]);
    });
  });

  describe("nearest", () => {
    it("gives -1 with nothing in range", () => {
      const grid = makeGrid();
      grid.build([4], [0], 1);
      expect(grid.nearest(0, 0, 3)).toBe(-1);
      expect(grid.nearest(0, 0, 4.5)).toBe(0);
      grid.build([], [], 0);
      expect(grid.nearest(0, 0, 100)).toBe(-1);
    });

    it("leaves out a point at exactly its range", () => {
      const grid = makeGrid();
      // 5 from the origin, a 3-4-5 triangle, so the length is exact.
      grid.build([3], [4], 1);
      expect(grid.nearest(0, 0, 5)).toBe(-1);
      expect(grid.nearest(0, 0, 5.25)).toBe(0);
    });

    it("gives the nearer of two points, whichever was built first", () => {
      const grid = makeGrid();
      grid.build([1, 3], [0, 0], 2);
      expect(grid.nearest(0, 0, 10)).toBe(0);
      grid.build([3, 1], [0, 0], 2);
      expect(grid.nearest(0, 0, 10)).toBe(1);
    });

    it("passes over a point whose skip is not 0", () => {
      const grid = makeGrid();
      grid.build([1, 2, 3], [0, 0, 0], 3);
      const skip = new Uint8Array(3);
      expect(grid.nearest(0, 0, 10, skip)).toBe(0);
      skip[0] = 1;
      expect(grid.nearest(0, 0, 10, skip)).toBe(1);
      skip[1] = 2;
      expect(grid.nearest(0, 0, 10, skip)).toBe(2);
      skip[2] = 1;
      expect(grid.nearest(0, 0, 10, skip)).toBe(-1);
    });

    it("refuses a skip mask shorter than the build", () => {
      const grid = makeGrid();
      grid.build([1, 2, 3], [0, 0, 0], 3);
      // Read past its end, a mask would pass over every point it does not cover.
      for (const skip of [[1, 0], []]) {
        expect(() => grid.nearest(0, 0, 10, skip)).toThrow(
          new RangeError(
            `SpatialGrid.nearest needs a skip mask as long as the build's 3 points, got ${skip.length}`
          )
        );
      }
      // A longer one is a pool's field: what is past the build's count is not read.
      expect(grid.nearest(0, 0, 10, [1, 0, 0, 1])).toBe(1);
      // And a grid with no points takes any mask.
      grid.build([], [], 0);
      expect(grid.nearest(0, 0, 10, [])).toBe(-1);
    });

    it("gives the lower index of two points at one distance, whichever was built first", () => {
      const grid = makeGrid();
      // In two cells: the one at -1 is visited first, whichever index it has.
      grid.build([1, -1], [0, 0], 2);
      expect(grid.nearest(0, 0, 10)).toBe(0);
      grid.build([-1, 1], [0, 0], 2);
      expect(grid.nearest(0, 0, 10)).toBe(0);
      // In one cell, whose list starts with the point built last.
      grid.build([0.5, 0, 0.5], [0, 0.5, 0], 3);
      expect(grid.nearest(0, 0, 10)).toBe(0);
      // And with the lower one skipped, the next.
      expect(grid.nearest(0, 0, 10, [1, 0, 0])).toBe(1);
    });

    it("measures to a centre, whatever the point's radius", () => {
      const grid = makeGrid();
      // Point 0's circle reaches to 0.5 from the origin, and its centre is the farther one.
      grid.build([3, 2], [0, 0], 2, [2.5, 0.125]);
      expect(grid.nearest(0, 0, 10)).toBe(1);
      expect(grid.nearest(0, 0, 2)).toBe(-1);
      expect(grid.nearest(0, 0, 3, [0, 1])).toBe(-1);
      expect(grid.nearest(0, 0, 3.5, [0, 1])).toBe(0);
    });

    it("agrees with a scan of every point, ties and skipped points included", () => {
      const rng = makeRng(2026);
      const count = 300;
      const grid = new SpatialGrid({
        halfSize: 10,
        cellSize: 2,
        capacity: count,
      });
      const xs = new Float32Array(count);
      const ys = new Float32Array(count);
      const skip = new Uint8Array(count);
      // Whole coordinates, so many points are at one distance, and some are past the grid's
      // edge, where they are kept in the edge cells.
      for (let i = 0; i < count; i++) {
        xs[i] = rng.int(25) - 12;
        ys[i] = rng.int(25) - 12;
        skip[i] = rng.int(4) === 0 ? 1 : 0;
      }
      grid.build(xs, ys, count);
      let found = 0;
      let ties = 0;
      for (let q = 0; q < 400; q++) {
        const x = rng.int(25) - 12;
        const y = rng.int(25) - 12;
        const range = rng.range(0, 4);
        const expected = scanNearest(xs, ys, count, x, y, range, skip);
        expect(grid.nearest(x, y, range, skip)).toBe(expected);
        if (expected === -1) {
          continue;
        }
        found += 1;
        const best = hypot2(xs[expected]! - x, ys[expected]! - y);
        for (let i = expected + 1; i < count; i++) {
          if (skip[i] === 0 && hypot2(xs[i]! - x, ys[i]! - y) === best) {
            ties += 1;
            break;
          }
        }
      }
      // The points must give hits, misses and ties, or the loop proves little.
      expect(found).toBeGreaterThan(100);
      expect(found).toBeLessThan(400);
      expect(ties).toBeGreaterThan(50);
    });
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
