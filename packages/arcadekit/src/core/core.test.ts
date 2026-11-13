import { describe, expect, expectTypeOf, it } from "vitest";

import {
  EventBuffer,
  FixedStepClock,
  RingReader,
  Side,
  SpatialGrid,
  StateHasher,
  countDown,
  createIdentifiedPool,
  createPool,
  createRing,
  createTileMap,
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
import type { Pool, PoolLayout, Ring, Rng, TileMap } from "./index";

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

const HIT_LAYOUT = { x: Float32Array, amount: Uint16Array };

/** Pushes a record and reads its fields before anything writes them, then writes both. */
const pushHit = (
  ring: Ring<typeof HIT_LAYOUT>,
  x: number,
  amount: number
): number[] => {
  const slot = ring.push();
  const clean = [slot, ring.fields.x[slot]!, ring.fields.amount[slot]!];
  ring.fields.x[slot] = x;
  ring.fields.amount[slot] = amount;
  return clean;
};

describe(createRing, () => {
  it("has one typed array of `capacity` for each field of its layout, and no record", () => {
    const ring = createRing(3, HIT_LAYOUT);
    // Each field is the typed array its layout names, not any of them.
    expectTypeOf(ring.fields.x).toExtend<Float32Array>();
    expectTypeOf(ring.fields.amount).toExtend<Uint16Array>();
    expectTypeOf(ring.fields.amount).not.toExtend<Float32Array>();
    expect([ring.fields.x, ring.fields.amount]).toStrictEqual([
      new Float32Array(3),
      new Uint16Array(3),
    ]);
    expect([ring.capacity, ring.written, ring.length]).toStrictEqual([3, 0, 0]);
  });

  it("pushes into slots 0 to capacity - 1 and then 0 again, each with every field 0", () => {
    const ring = createRing(3, HIT_LAYOUT);
    expect([
      pushHit(ring, 1.5, 10),
      pushHit(ring, 2.5, 20),
      pushHit(ring, 3.5, 30),
    ]).toStrictEqual([
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ]);
    // The ring is full: every slot holds what its record wrote.
    expect([[...ring.fields.x], [...ring.fields.amount]]).toStrictEqual([
      [1.5, 2.5, 3.5],
      [10, 20, 30],
    ]);
    // Records 3 and 4 overwrite records 0 and 1, and their slots come back clean.
    expect([pushHit(ring, 4.5, 40), pushHit(ring, 5.5, 50)]).toStrictEqual([
      [0, 0, 0],
      [1, 0, 0],
    ]);
    expect([[...ring.fields.x], [...ring.fields.amount]]).toStrictEqual([
      [4.5, 5.5, 3.5],
      [40, 50, 30],
    ]);
  });

  it("counts every push in `written`, and in `length` up to its capacity", () => {
    const ring = createRing(3, HIT_LAYOUT);
    const counts: number[][] = [];
    for (let n = 0; n < 5; n++) {
      ring.push();
      counts.push([ring.written, ring.length]);
    }
    expect(counts).toStrictEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 3],
      [5, 3],
    ]);
  });

  it("gives record n's slot, n % capacity, which is where push put it", () => {
    const ring = createRing(3, HIT_LAYOUT);
    const pushed = Array.from({ length: 7 }, () => ring.push());
    expect(pushed).toStrictEqual([0, 1, 2, 0, 1, 2, 0]);
    expect(pushed.map((_, n) => ring.slotOf(n))).toStrictEqual(pushed);
  });

  it("pops the newest record's slot, and lowers both counts", () => {
    const ring = createRing(4, HIT_LAYOUT);
    pushHit(ring, 1.5, 10);
    pushHit(ring, 2.5, 20);
    pushHit(ring, 3.5, 30);
    expect([ring.pop(), ring.written, ring.length]).toStrictEqual([2, 2, 2]);
    // The record is still there to read: a pop forgets it, and the next push cleans its slot.
    expect([ring.fields.x[2], ring.fields.amount[2]]).toStrictEqual([3.5, 30]);
    expect([ring.pop(), ring.written, ring.length]).toStrictEqual([1, 1, 1]);
    expect([pushHit(ring, 4.5, 40), ring.written, ring.length]).toStrictEqual([
      [1, 0, 0],
      2,
      2,
    ]);
    expect([
      ring.pop(),
      ring.pop(),
      ring.pop(),
      ring.written,
      ring.length,
    ]).toStrictEqual([1, 0, -1, 0, 0]);
  });

  it("pops `capacity` records after capacity + 1 pushes, and then -1", () => {
    const ring = createRing(3, HIT_LAYOUT);
    for (const amount of [10, 20, 30, 40]) {
      pushHit(ring, 0, amount);
    }
    // Newest first: records 3, 2 and 1. Record 0 was overwritten by record 3.
    const popped = [ring.pop(), ring.pop(), ring.pop()];
    expect(popped).toStrictEqual([0, 2, 1]);
    expect(popped.map((slot) => ring.fields.amount[slot])).toStrictEqual([
      40, 30, 20,
    ]);
    // One record was written and not popped, and it is not held any more.
    expect([ring.written, ring.length]).toStrictEqual([1, 0]);
    expect([ring.pop(), ring.written, ring.length]).toStrictEqual([-1, 1, 0]);
    // The next record is number 1, in slot 1.
    expect([pushHit(ring, 0, 50), ring.written, ring.length]).toStrictEqual([
      [1, 0, 0],
      2,
      1,
    ]);
  });

  it("forgets every record on clear, and starts again at slot 0", () => {
    const ring = createRing(3, HIT_LAYOUT);
    for (const amount of [10, 20, 30, 40, 50]) {
      pushHit(ring, 0, amount);
    }
    ring.clear();
    expect([ring.written, ring.length, ring.pop()]).toStrictEqual([0, 0, -1]);
    // `clear` only forgets the counts: each slot is cleaned as `push` hands it out.
    expect([...ring.fields.amount]).toStrictEqual([40, 50, 30]);
    expect(pushHit(ring, 0, 60)).toStrictEqual([0, 0, 0]);
  });

  it("refuses a capacity that is not a whole number of 1 or more", () => {
    for (const capacity of [0, -1, 2.5, Number.NaN, Infinity]) {
      expect(() => createRing(capacity, HIT_LAYOUT)).toThrow(
        new RangeError(
          `createRing needs a whole capacity of 1 or more, got ${capacity}`
        )
      );
    }
    expect(createRing(1, HIT_LAYOUT).capacity).toBe(1);
  });
});

/** The records a reader takes from a ring now, by number. */
const taken = (
  reader: RingReader,
  ring: Pick<Ring<PoolLayout>, "capacity" | "written">
): number[] => {
  const numbers: number[] = [];
  for (let n = reader.take(ring); n < ring.written; n++) {
    numbers.push(n);
  }
  return numbers;
};

const pushTimes = (ring: Ring<typeof HIT_LAYOUT>, times: number) => {
  for (let i = 0; i < times; i++) {
    ring.push();
  }
};

describe(RingReader, () => {
  it("gives `written` on its first take: what was pushed before it looked is not taken", () => {
    const ring = createRing(4, HIT_LAYOUT);
    pushTimes(ring, 2);
    const reader = new RingReader();
    expect(reader.take(ring)).toBe(2);
    // And a ring nothing was pushed to starts at 0.
    expect(new RingReader().take(createRing(4, HIT_LAYOUT))).toBe(0);
  });

  it("gives where it stopped, so each record is taken once", () => {
    const ring = createRing(4, HIT_LAYOUT);
    const reader = new RingReader();
    expect(taken(reader, ring)).toStrictEqual([]);
    pushTimes(ring, 3);
    expect(taken(reader, ring)).toStrictEqual([0, 1, 2]);
    expect(taken(reader, ring)).toStrictEqual([]);
    pushTimes(ring, 2);
    expect(taken(reader, ring)).toStrictEqual([3, 4]);
    // A whole ring of new records is not a lap: none was overwritten.
    pushTimes(ring, 4);
    expect(taken(reader, ring)).toStrictEqual([5, 6, 7, 8]);
  });

  it("gives `written - capacity` once the ring has lapped it: the oldest are lost", () => {
    const ring = createRing(4, HIT_LAYOUT);
    const reader = new RingReader();
    pushTimes(ring, 1);
    expect(reader.take(ring)).toBe(1);
    // Six more: records 1 and 2 were overwritten by 5 and 6 before the reader looked.
    pushTimes(ring, 6);
    expect(reader.take(ring)).toBe(3);
    expect(reader.take(ring)).toBe(7);
  });

  it("reads each record it takes from the slot `slotOf` gives", () => {
    const ring = createRing(3, HIT_LAYOUT);
    const reader = new RingReader();
    reader.take(ring);
    for (const amount of [10, 20, 30, 40, 50]) {
      pushHit(ring, 0, amount);
    }
    const amounts: number[] = [];
    for (let n = reader.take(ring); n < ring.written; n++) {
      amounts.push(ring.fields.amount[ring.slotOf(n)]!);
    }
    expect(amounts).toStrictEqual([30, 40, 50]);
  });

  it("starts again at `written` for another ring", () => {
    const first = createRing(4, HIT_LAYOUT);
    const second = createRing(4, HIT_LAYOUT);
    const reader = new RingReader();
    reader.take(first);
    pushTimes(first, 2);
    // A new run's ring. By its counts alone it is the first one with a record to take: the
    // reader tells them apart by which object it is handed.
    pushTimes(second, 1);
    expect(reader.take(second)).toBe(1);
    pushTimes(second, 2);
    expect(taken(reader, second)).toStrictEqual([1, 2]);
    // Back on the first, it starts again there too: it follows one ring at a time.
    expect(reader.take(first)).toBe(2);
  });

  it("starts again at `written` after reset", () => {
    const ring = createRing(4, HIT_LAYOUT);
    const reader = new RingReader();
    reader.take(ring);
    pushTimes(ring, 2);
    reader.reset();
    expect(reader.take(ring)).toBe(2);
    pushTimes(ring, 1);
    expect(taken(reader, ring)).toStrictEqual([2]);
  });

  it("starts again at `written` when it finds a ring popped or cleared below what it took", () => {
    const ring = createRing(4, HIT_LAYOUT);
    const reader = new RingReader();
    pushTimes(ring, 3);
    reader.take(ring);
    ring.pop();
    expect(reader.take(ring)).toBe(2);
    pushTimes(ring, 2);
    expect(taken(reader, ring)).toStrictEqual([2, 3]);
    ring.clear();
    expect(reader.take(ring)).toBe(0);
    pushTimes(ring, 1);
    expect(taken(reader, ring)).toStrictEqual([0]);
  });

  it("leaves a second reader of the same ring where it was", () => {
    const ring = createRing(4, HIT_LAYOUT);
    const drawing = new RingReader();
    const sound = new RingReader();
    drawing.take(ring);
    sound.take(ring);
    pushTimes(ring, 2);
    expect(taken(drawing, ring)).toStrictEqual([0, 1]);
    pushTimes(ring, 1);
    expect(taken(drawing, ring)).toStrictEqual([2]);
    // The other reader has taken nothing since its first look, whatever the first one took.
    expect(taken(sound, ring)).toStrictEqual([0, 1, 2]);
    expect(taken(drawing, ring)).toStrictEqual([]);
    // And taking writes nothing to the ring.
    expect([ring.written, ring.length]).toStrictEqual([3, 3]);
  });

  it("takes anything with a ring's two counts", () => {
    // What a module that imports no ring is handed: the shape alone.
    const counts = { capacity: 2, written: 5 };
    const reader = new RingReader();
    expect(reader.take(counts)).toBe(5);
    counts.written = 9;
    expect(reader.take(counts)).toBe(7);
  });
});

/** A level's cells: 1 in `tile` where a cell is a wall, and how high its ground is. */
const LEVEL_LAYOUT = { tile: Uint8Array, height: Float32Array };

/** A map from rows of text: `#` is a wall, and any other character is open ground. */
const mapOf = (rows: readonly string[]): TileMap<typeof LEVEL_LAYOUT> => {
  const map = createTileMap(rows[0]!.length, rows.length, LEVEL_LAYOUT);
  for (const [row, text] of rows.entries()) {
    for (const [col, char] of [...text].entries()) {
      map.fields.tile[map.cellAt(col, row)] = char === "#" ? 1 : 0;
    }
  }
  return map;
};

/** A mask as rows of text: `x` for a cell that is marked, `.` for one that is not. */
const marked = (
  map: TileMap<typeof LEVEL_LAYOUT>,
  reached: Uint8Array
): string[] =>
  Array.from({ length: map.rows }, (_, row) =>
    Array.from({ length: map.cols }, (__, col) =>
      reached[map.cellAt(col, row)] === 1 ? "x" : "."
    ).join("")
  );

/** A `passes` that accepts every cell. */
const everyCell = (): boolean => true;

/** The cell on each side of `cell`. */
const sidesOf = (map: TileMap<typeof LEVEL_LAYOUT>, cell: number) => ({
  west: map.neighbor(cell, Side.west),
  east: map.neighbor(cell, Side.east),
  north: map.neighbor(cell, Side.north),
  south: map.neighbor(cell, Side.south),
});

describe(createTileMap, () => {
  it("has one typed array of cols * rows for each field of its layout, every cell 0", () => {
    const map = createTileMap(4, 3, LEVEL_LAYOUT);
    // Each field is the typed array its layout names, not any of them.
    expectTypeOf(map.fields.tile).toExtend<Uint8Array>();
    expectTypeOf(map.fields.height).toExtend<Float32Array>();
    expectTypeOf(map.fields.height).not.toExtend<Uint8Array>();
    expect([map.cols, map.rows, map.cells]).toStrictEqual([4, 3, 12]);
    expect([map.fields.tile, map.fields.height]).toStrictEqual([
      new Uint8Array(12),
      new Float32Array(12),
    ]);
  });

  it("gives the cell at a column and a row, row * cols + col, and -1 off each edge", () => {
    const map = createTileMap(4, 3, LEVEL_LAYOUT);
    // The four corners, then one inside.
    expect([
      map.cellAt(0, 0),
      map.cellAt(3, 0),
      map.cellAt(0, 2),
      map.cellAt(3, 2),
      map.cellAt(2, 1),
    ]).toStrictEqual([0, 3, 8, 11, 6]);
    // Off the west, east, north and south edges. A column past the east edge is no cell of
    // the next row, which `row * cols + col` alone would give.
    expect([
      map.cellAt(-1, 1),
      map.cellAt(4, 1),
      map.cellAt(1, -1),
      map.cellAt(1, 3),
    ]).toStrictEqual([-1, -1, -1, -1]);
  });

  it("gives a cell's column and its row back", () => {
    const map = createTileMap(4, 3, LEVEL_LAYOUT);
    expect([map.colOf(6), map.rowOf(6)]).toStrictEqual([2, 1]);
    expect([map.colOf(11), map.rowOf(11)]).toStrictEqual([3, 2]);
    for (let cell = 0; cell < map.cells; cell++) {
      expect(map.cellAt(map.colOf(cell), map.rowOf(cell))).toBe(cell);
    }
  });

  it("numbers the sides west, east, north and south, with north the row above", () => {
    // A game that looks around a cell side by side does it in this order.
    expect(Side).toStrictEqual({ west: 0, east: 1, north: 2, south: 3 });
    const map = createTileMap(4, 3, LEVEL_LAYOUT);
    expect(map.rowOf(map.neighbor(5, Side.north))).toBe(map.rowOf(5) - 1);
  });

  it("gives the cell on each side, and -1 at each edge", () => {
    const map = createTileMap(4, 3, LEVEL_LAYOUT);
    // Cell 5 is (1, 1): every side is on the map.
    expect(sidesOf(map, 5)).toStrictEqual({
      west: 4,
      east: 6,
      north: 1,
      south: 9,
    });
    // The first and the last cell: two edges each.
    expect(sidesOf(map, 0)).toStrictEqual({
      west: -1,
      east: 1,
      north: -1,
      south: 4,
    });
    expect(sidesOf(map, 11)).toStrictEqual({
      west: 10,
      east: -1,
      north: 7,
      south: -1,
    });
    // A row's last cell and the next row's first are one apart, and no neighbours.
    expect([
      map.neighbor(3, Side.east),
      map.neighbor(4, Side.west),
    ]).toStrictEqual([-1, -1]);
  });

  it("gives -1 for the neighbour of no cell, and for a side that is none", () => {
    const map = createTileMap(4, 3, LEVEL_LAYOUT);
    const nowhere = { west: -1, east: -1, north: -1, south: -1 };
    // So one lookup can follow another, with no test between them.
    expect(sidesOf(map, -1)).toStrictEqual(nowhere);
    // Nor of any other cell off the map: the one past the last is no cell of a fourth row, whose
    // neighbour above would be cell 8, and -4 none of a row above the first.
    expect(sidesOf(map, map.cells)).toStrictEqual(nowhere);
    expect(sidesOf(map, -4)).toStrictEqual(nowhere);
    expect(
      // @ts-expect-error -- a side is one of the four `Side` has, and 4 is none.
      map.neighbor(5, 4)
    ).toBe(-1);
  });

  it("refuses a number of columns or of rows that is not a whole number of 1 or more", () => {
    for (const [cols, rows] of [
      [0, 3],
      [3, 0],
      [-1, 2],
      [2.5, 2],
      [2, Number.NaN],
      [Infinity, 1],
    ] as const) {
      expect(() => createTileMap(cols, rows, LEVEL_LAYOUT)).toThrow(
        new RangeError(
          `createTileMap needs a whole number of columns and of rows, 1 or more of each, got ${cols} by ${rows}`
        )
      );
    }
    expect(createTileMap(1, 1, LEVEL_LAYOUT).cells).toBe(1);
  });

  describe("flood", () => {
    it("marks the start and what joins it by sides through passing cells, and counts them", () => {
      const map = mapOf(["..#.", ".#..", "#..."]);
      const { tile } = map.fields;
      const reached = new Uint8Array(map.cells);
      // The walls stop it, and a cell that only touches a marked one at a corner is not joined.
      expect(
        map.flood(map.cellAt(0, 0), (cell) => tile[cell] === 0, reached)
      ).toBe(3);
      expect(marked(map, reached)).toStrictEqual(["xx..", "x...", "...."]);
    });

    it("stops at a cell `passes` refuses, and asks it of no cell it has marked", () => {
      const map = mapOf([".....", ".###.", "....."]);
      const { tile } = map.fields;
      const reached = new Uint8Array(map.cells);
      const asked: number[] = [];
      const count = map.flood(
        map.cellAt(0, 1),
        (cell) => {
          asked.push(cell);
          // The middle column is closed too: the ring of open ground is cut at the top and
          // the bottom, so the east side is joined to the start by no passing cell.
          return tile[cell] === 0 && map.colOf(cell) !== 2;
        },
        reached
      );
      expect(count).toBe(5);
      expect(marked(map, reached)).toStrictEqual(["xx...", "x....", "xx..."]);
      // It asks about a cell before it enters it, and never once the cell is marked: not about
      // the start, and once about each cell it entered.
      expect(
        asked.filter((cell) => reached[cell] === 1).toSorted((a, b) => a - b)
      ).toStrictEqual([0, 1, 10, 11]);
      // A refused cell is asked about from each marked cell beside it: the wall at (1, 1) from
      // three, and the two closed cells of the middle column from one each.
      expect(
        asked.filter((cell) => reached[cell] === 0).toSorted((a, b) => a - b)
      ).toStrictEqual([2, 6, 6, 6, 12]);
    });

    it("marks every cell of a map that all passes", () => {
      const map = createTileMap(4, 3, LEVEL_LAYOUT);
      const reached = new Uint8Array(map.cells);
      expect(map.flood(5, everyCell, reached)).toBe(12);
      expect(marked(map, reached)).toStrictEqual(["xxxx", "xxxx", "xxxx"]);
    });

    it("marks the start whatever `passes` says of it", () => {
      const map = mapOf(["#.."]);
      const { tile } = map.fields;
      const reached = new Uint8Array(map.cells);
      // From a wall: the wall, and the open ground beside it.
      expect(map.flood(0, (cell) => tile[cell] === 0, reached)).toBe(3);
      expect(marked(map, reached)).toStrictEqual(["xxx"]);
      // A start with nothing that passes around it is marked alone.
      reached.fill(0);
      expect(map.flood(2, () => false, reached)).toBe(1);
      expect(marked(map, reached)).toStrictEqual(["..x"]);
    });

    it("does not enter a cell already marked, so two floods share a mask", () => {
      const map = createTileMap(5, 1, LEVEL_LAYOUT);
      const reached = new Uint8Array(map.cells);
      // The caller's mark in the middle cuts the row in two.
      reached[2] = 1;
      expect(map.flood(0, everyCell, reached)).toBe(2);
      expect(marked(map, reached)).toStrictEqual(["xxx.."]);
      // The second flood marks the other side, into the same mask.
      expect(map.flood(4, everyCell, reached)).toBe(2);
      expect(marked(map, reached)).toStrictEqual(["xxxxx"]);
    });

    it("marks nothing from a cell already marked, whichever flood marked it", () => {
      const map = createTileMap(5, 1, LEVEL_LAYOUT);
      const reached = new Uint8Array(map.cells);
      reached[2] = 1;
      map.flood(0, everyCell, reached);
      // From a cell the flood marked, and from the one the caller marked: cells 3 and 4 are
      // beside it, and stay as they are.
      expect([
        map.flood(1, everyCell, reached),
        map.flood(2, everyCell, reached),
      ]).toStrictEqual([0, 0]);
      expect(marked(map, reached)).toStrictEqual(["xxx.."]);
    });

    it("marks nothing from a start off the map", () => {
      const map = createTileMap(3, 2, LEVEL_LAYOUT);
      const reached = new Uint8Array(map.cells);
      // What `cellAt` and `neighbor` give off the map, and the cell past the last.
      expect([
        map.flood(-1, everyCell, reached),
        map.flood(map.cells, everyCell, reached),
      ]).toStrictEqual([0, 0]);
      expect(marked(map, reached)).toStrictEqual(["...", "..."]);
    });

    it("refuses a mask shorter than the map, wherever it starts, and marks nothing", () => {
      const map = createTileMap(4, 3, LEVEL_LAYOUT);
      // A typed array drops a write past its end: given a row's worth of mask, a flood of this
      // open map would mark that row and count 4 cells of 12.
      const short = new Uint8Array(4);
      // From a cell the mask covers, one it doesn't, and one off the map.
      for (const start of [0, 6, -1]) {
        expect(() => map.flood(start, everyCell, short)).toThrow(
          new RangeError(
            "TileMap.flood needs a reached mask as long as the map's 12 cells, got 4"
          )
        );
      }
      expect([...short]).toStrictEqual([0, 0, 0, 0]);
    });

    it("takes a mask longer than the map, and leaves what is past its cells", () => {
      const map = createTileMap(4, 3, LEVEL_LAYOUT);
      const long = new Uint8Array(map.cells + 2);
      expect(map.flood(0, everyCell, long)).toBe(12);
      expect([...long.subarray(map.cells)]).toStrictEqual([0, 0]);
    });
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
