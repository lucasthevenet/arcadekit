import { describe, expect, expectTypeOf, it } from "vitest";

import {
  EntityPool,
  EventBuffer,
  ExactMath,
  FixedStepClock,
  Ring,
  RingReader,
  Rng,
  SpatialGrid,
  StateHash,
  TileMap,
  Timer,
  Tween,
} from "../../src/core/index";
import type { Layout } from "../../src/core/index";

describe("Rng.make", () => {
  it("repeats for the same seed and differs for another", () => {
    const a = Rng.make(1);
    const b = Rng.make(1);
    const c = Rng.make(2);
    const seqA = Array.from({ length: 5 }, () => Rng.next(a));
    expect(Array.from({ length: 5 }, () => Rng.next(b))).toStrictEqual(seqA);
    expect(Array.from({ length: 5 }, () => Rng.next(c))).not.toStrictEqual(
      seqA
    );
    expect(seqA.every((v) => v >= 0 && v < 1)).toBe(true);
  });
});

/** The draw a generator makes after `draws` earlier ones. */
const drawAfter = (seed: number, draws: number): number => {
  const rng = Rng.make(seed);
  for (let i = 0; i < draws; i++) {
    Rng.next(rng);
  }
  return Rng.next(rng);
};

/**
 * Picks from what a pick can't reorder: each is a type error. A list a game shares between
 * runs, such as its content, is `readonly`, and a game picks from a copy of it.
 */
const pickMistyped = (rng: Rng.Rng) => {
  const content: readonly string[] = ["boost", "magnet", "shield"];
  const fixed = ["boost", "magnet", "shield"] as const;
  return [
    // @ts-expect-error -- a readonly array can't be reordered in place.
    Rng.pickDistinct(rng, content, 2),
    // @ts-expect-error -- nor can a readonly tuple.
    Rng.pickDistinct(rng, fixed, 2),
    // @ts-expect-error -- nor can a string.
    Rng.pickDistinct(rng, "abc", 0),
    // @ts-expect-error -- a DataView is over a buffer, and has no items.
    Rng.pickDistinct(rng, new DataView(new ArrayBuffer(8)), 0),
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
      const rng = Rng.make(7);
      const items = Array.from({ length }, (_, i) => i);
      expect(Rng.pickDistinct(rng, items, count)).toBe(draws);
      // The generator is where `draws` draws leave it: no more, no fewer.
      expect(Rng.next(rng)).toBe(drawAfter(7, draws));
    }
  });

  it("leaves a permutation of the items, the picks at the front", () => {
    const rng = Rng.make(42);
    const items = ["a", "b", "c", "d", "e", "f", "g"];
    const count = Rng.pickDistinct(rng, items, 3);
    expect(count).toBe(3);
    expect(items.toSorted()).toStrictEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(new Set(items.slice(0, count)).size).toBe(3);
  });

  it("swaps item i with the one drawn at i + int(length - i), for each pick in turn", () => {
    // The contract every later draw of a run follows from: the same draws, in the same order.
    const rng = Rng.make(2026);
    const twin = Rng.make(2026);
    const items = [10, 20, 30, 40, 50, 60];
    const expected = [...items];
    for (let i = 0; i < 4; i++) {
      const j = i + Rng.int(twin, expected.length - i);
      [expected[i], expected[j]] = [expected[j]!, expected[i]!];
    }
    Rng.pickDistinct(rng, items, 4);
    expect(items).toStrictEqual(expected);
    // Not left in order by accident: a pick that swapped nothing would pass the line above.
    expect(items).not.toStrictEqual([10, 20, 30, 40, 50, 60]);
  });

  it("picks every item about as often", () => {
    const rng = Rng.make(5);
    const picked = [0, 0, 0, 0, 0];
    for (let run = 0; run < 5000; run++) {
      const items = [0, 1, 2, 3, 4];
      const count = Rng.pickDistinct(rng, items, 2);
      for (let i = 0; i < count; i++) {
        picked[items[i]!]! += 1;
      }
    }
    // 10,000 picks over 5 items: 2,000 each, give or take.
    expect(Math.min(...picked)).toBeGreaterThan(1850);
    expect(Math.max(...picked)).toBeLessThan(2150);
  });

  it("takes a typed array, so a pick of pool indices allocates nothing", () => {
    const rng = Rng.make(3);
    const twin = Rng.make(3);
    const indices = new Uint16Array([5, 6, 7, 8, 9]);
    const asArray = [5, 6, 7, 8, 9];
    const count = Rng.pickDistinct(rng, indices, 2);
    expectTypeOf(count).toEqualTypeOf<number>();
    expect(count).toBe(Rng.pickDistinct(twin, asArray, 2));
    expect([...indices]).toStrictEqual(asArray);
    expect([...indices].toSorted()).toStrictEqual([5, 6, 7, 8, 9]);
  });

  it("refuses, as a type error, a list it can't reorder", () => {
    // Nothing checks it at run time: past the types, by a cast, a pick reorders a list its
    // owner calls readonly.
    expect(() => pickMistyped(Rng.make(3))).not.toThrow();
  });

  it("refuses a count that is not a whole number of 0 or more, before it draws", () => {
    for (const count of [-1, 2.5, 0.5, Number.NaN, Infinity]) {
      const rng = Rng.make(7);
      const items = ["a", "b", "c", "d"];
      expect(() => Rng.pickDistinct(rng, items, count)).toThrow(
        new RangeError(
          `Rng.pickDistinct needs a whole count of 0 or more, got ${count}`
        )
      );
      // Nothing was drawn and nothing moved, so a refused pick leaves the run as it was.
      expect(items).toStrictEqual(["a", "b", "c", "d"]);
      expect(Rng.next(rng)).toBe(drawAfter(7, 0));
    }
  });
});

describe("Timer.countDown", () => {
  it("lowers a timer, and stops at 0", () => {
    expect(Timer.countDown(0.5, 0.125)).toBe(0.375);
    expect(Timer.countDown(0.125, 0.125)).toBe(0);
    expect(Timer.countDown(0.1, 0.125)).toBe(0);
    expect(Timer.countDown(0, 0.125)).toBe(0);
    // Ready is +0, whatever the subtraction left.
    expect(Object.is(Timer.countDown(-0, 0), 0)).toBe(true);
  });

  it("is Math.max(0, value - by), bit for bit", () => {
    const dt = 1 / 60;
    let timer = 0.15;
    let written = 0.15;
    for (let step = 0; step < 12; step++) {
      timer = Timer.countDown(timer, dt);
      written = Math.max(0, written - dt);
      expect(timer).toBe(written);
    }
    expect(timer).toBe(0);
  });
});

describe("Timer.takeWhole", () => {
  it("gives 0 below 1, and for NaN", () => {
    expect(
      [0, 0.999, -3.5, -Infinity, Number.NaN].map(Timer.takeWhole)
    ).toStrictEqual([0, 0, 0, 0, 0]);
  });

  it("gives the whole units from 1 up", () => {
    expect([1, 1.999, 7.25, 600].map(Timer.takeWhole)).toStrictEqual([
      1, 1, 7, 600,
    ]);
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
      const due = Timer.takeWhole(budget);
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

describe("Tween.progress", () => {
  it("goes from 0 at `startedAt` to 1 at `startedAt + duration`", () => {
    expect(Tween.progress(10, 10, 4)).toBe(0);
    expect(Tween.progress(11, 10, 4)).toBe(0.25);
    expect(Tween.progress(13, 10, 4)).toBe(0.75);
    expect(Tween.progress(14, 10, 4)).toBe(1);
  });

  it("stays at 0 before `startedAt` and at 1 after the end", () => {
    expect(Tween.progress(9, 10, 4)).toBe(0);
    expect(Tween.progress(-1000, 10, 4)).toBe(0);
    expect(Tween.progress(15, 10, 4)).toBe(1);
    expect(Tween.progress(Infinity, 10, 4)).toBe(1);
  });

  it("is 1 for a `startedAt` of -Infinity: what never started is done", () => {
    expect(Tween.progress(0, -Infinity, 0.09)).toBe(1);
    expect(Tween.progress(123.4, -Infinity, 0.09)).toBe(1);
  });

  it("is 1 for a `duration` of 0, and divides nothing", () => {
    expect(Tween.progress(10, 10, 0)).toBe(1);
    expect(Tween.progress(11, 10, 0)).toBe(1);
    expect(Tween.progress(9, 10, 0)).toBe(0);
  });
});

describe("the eases", () => {
  it.each([
    ["easeIn", Tween.easeIn],
    ["easeOut", Tween.easeOut],
    ["easeOutCubic", Tween.easeOutCubic],
    ["smoothstep", Tween.smoothstep],
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
    expect(Tween.easeIn(0.25)).toBe(0.0625);
    expect(Tween.easeOut(0.25)).toBe(0.4375);
    expect(Tween.easeOutCubic(0.5)).toBe(0.875);
    expect(Tween.smoothstep(0.25)).toBe(0.15625);
  });

  it("are their expressions, bit for bit", () => {
    // A step may call an ease, so the order of its operations is fixed. Each is pinned where
    // another way to write the same polynomial gives other bits.
    expect(Tween.easeIn(0.1)).toBe(0.010000000000000002);
    expect(Tween.easeOut(0.9)).toBe(0.9900000000000001);
    expect(Tween.easeOutCubic(0.1)).toBe(0.2709999999999999);
    expect([Tween.smoothstep(0.1), Tween.smoothstep(0.3)]).toStrictEqual([
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
    expect(Tween.easeIn(0.5)).toBeLessThan(0.5);
    expect(Tween.easeOut(0.5)).toBeGreaterThan(0.5);
    expect(Tween.easeOutCubic(0.5)).toBeGreaterThan(Tween.easeOut(0.5));
    expect(Tween.smoothstep(0.5)).toBe(0.5);
  });

  it("smoothstep clamps", () => {
    expect(
      [-0.5, -Infinity, 1.5, Infinity].map(Tween.smoothstep)
    ).toStrictEqual([0, 0, 1, 1]);
  });

  it("the others don't clamp: a caller passes them a progress", () => {
    expect([
      Tween.easeIn(2),
      Tween.easeOut(2),
      Tween.easeOutCubic(2),
    ]).toStrictEqual([4, 0, 2]);
  });
});

describe("EntityPool.make", () => {
  it("packs entities and swaps the last one into removed slots", () => {
    const pool = EntityPool.make(3, { x: Float32Array, id: Uint16Array });
    for (const id of [10, 20, 30]) {
      const i = EntityPool.add(pool);
      pool.fields.x[i] = id / 10;
      pool.fields.id[i] = id;
    }
    expect(EntityPool.add(pool)).toBe(-1);
    EntityPool.remove(pool, 0);
    expect(pool.count).toBe(2);
    expect([...pool.fields.id.subarray(0, pool.count)]).toStrictEqual([30, 20]);
    expect(pool.fields.x[0]).toBe(3);
    EntityPool.clear(pool);
    expect(pool.count).toBe(0);
  });

  it("gives a slot whose fields are all 0, whatever its last entity left", () => {
    const pool = EntityPool.make(3, { x: Float32Array, id: Uint16Array });
    /** Adds an entity and reads its fields before anything writes them. */
    const added = () => {
      const i = EntityPool.add(pool);
      return [i, pool.fields.x[i], pool.fields.id[i]];
    };
    const fill = (x: number, id: number) => {
      const i = EntityPool.add(pool);
      pool.fields.x[i] = x;
      pool.fields.id[i] = id;
    };
    fill(1.5, 10);
    fill(2.5, 20);
    fill(3.5, 30);
    // Removing the first moves the last into it, and leaves the last slot as it was.
    EntityPool.remove(pool, 0);
    expect([pool.fields.x[2], pool.fields.id[2]]).toStrictEqual([3.5, 30]);
    expect(added()).toStrictEqual([2, 0, 0]);
    // The entities beside it keep theirs.
    expect([...pool.fields.id.subarray(0, 2)]).toStrictEqual([30, 20]);

    pool.fields.x[2] = 4.5;
    pool.fields.id[2] = 40;
    EntityPool.clear(pool);
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
  const pool = EntityPool.makeIdentified(4, { x: Float32Array });
  for (const x of [10, 20, 30]) {
    pool.fields.x[EntityPool.add(pool)] = x;
  }
  return pool;
};
/** Each live entity as [id, x], in index order. */
const entries = (pool: ReturnType<typeof filled>) =>
  Array.from({ length: pool.count }, (_, i) => [
    EntityPool.idOf(pool, i),
    pool.fields.x[i],
  ]);

describe("EntityPool.makeIdentified", () => {
  it("hands out ids 0, 1, 2… and finds each entity by id", () => {
    const pool = filled();
    expect(entries(pool)).toStrictEqual([
      [0, 10],
      [1, 20],
      [2, 30],
    ]);
    expect(EntityPool.indexOf(pool, 1)).toBe(1);
    expect(EntityPool.indexOf(pool, 3)).toBe(-1);
    expect(EntityPool.indexOf(pool, -1)).toBe(-1);
  });

  it("keeps every id with its entity when another is removed", () => {
    const pool = filled();
    EntityPool.remove(pool, 0);
    expect(entries(pool)).toStrictEqual([
      [2, 30],
      [1, 20],
    ]);
    expect(EntityPool.indexOf(pool, 0)).toBe(-1);
    expect(pool.fields.x[EntityPool.indexOf(pool, 2)]).toBe(30);
  });

  it("brings a removed entity back under its old id", () => {
    const pool = filled();
    EntityPool.remove(pool, EntityPool.indexOf(pool, 1));
    const i = EntityPool.addWithId(pool, 1);
    pool.fields.x[i] = 20;
    expect(EntityPool.indexOf(pool, 1)).toBe(i);
    expect(pool.count).toBe(3);
    // The other free id is the one `add` hands out next.
    expect(EntityPool.idOf(pool, EntityPool.add(pool))).toBe(3);
  });

  it("gives a slot whose fields are all 0 from add and from addWithId", () => {
    const pool = EntityPool.makeIdentified(4, {
      x: Float32Array,
      hp: Uint8Array,
    });
    for (const x of [10, 20, 30]) {
      const i = EntityPool.add(pool);
      pool.fields.x[i] = x;
      pool.fields.hp[i] = x / 10;
    }
    // The last entity, id 2, leaves its values in slot 2.
    EntityPool.remove(pool, 2);
    expect([pool.fields.x[2], pool.fields.hp[2]]).toStrictEqual([30, 3]);
    const back = EntityPool.addWithId(pool, 2);
    expect([back, pool.fields.x[back], pool.fields.hp[back]]).toStrictEqual([
      2, 0, 0,
    ]);

    pool.fields.x[back] = 30;
    pool.fields.hp[back] = 3;
    EntityPool.remove(pool, EntityPool.indexOf(pool, 2));
    const next = EntityPool.add(pool);
    expect([next, pool.fields.x[next], pool.fields.hp[next]]).toStrictEqual([
      2, 0, 0,
    ]);

    pool.fields.x[next] = 40;
    EntityPool.clear(pool);
    expect([...pool.fields.x]).toStrictEqual([10, 20, 40, 0]);
    // Id 1 is free again after the clear, and its slot is the first one handed out.
    const first = EntityPool.addWithId(pool, 1);
    expect([first, pool.fields.x[first], pool.fields.hp[first]]).toStrictEqual([
      0, 0, 0,
    ]);
  });

  it("refuses an id that is in use, and any id when full", () => {
    const pool = filled();
    expect(EntityPool.addWithId(pool, 0)).toBe(-1);
    expect(EntityPool.addWithId(pool, 4)).toBe(-1);
    EntityPool.add(pool);
    expect(EntityPool.addWithId(pool, 3)).toBe(-1);
  });

  it("starts again from id 0 after clear", () => {
    const pool = filled();
    EntityPool.remove(pool, 1);
    EntityPool.clear(pool);
    expect(EntityPool.idOf(pool, EntityPool.add(pool))).toBe(0);
    expect(EntityPool.idOf(pool, EntityPool.add(pool))).toBe(1);
  });
});

const HIT_LAYOUT = { x: Float32Array, amount: Uint16Array };

/** Pushes a record and reads its fields before anything writes them, then writes both. */
const pushHit = (
  ring: Ring.Ring<typeof HIT_LAYOUT>,
  x: number,
  amount: number
): number[] => {
  const slot = Ring.push(ring);
  const clean = [slot, ring.fields.x[slot]!, ring.fields.amount[slot]!];
  ring.fields.x[slot] = x;
  ring.fields.amount[slot] = amount;
  return clean;
};

describe("Ring.make", () => {
  it("has one typed array of `capacity` for each field of its layout, and no record", () => {
    const ring = Ring.make(3, HIT_LAYOUT);
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
    const ring = Ring.make(3, HIT_LAYOUT);
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
    const ring = Ring.make(3, HIT_LAYOUT);
    const counts: number[][] = [];
    for (let n = 0; n < 5; n++) {
      Ring.push(ring);
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
    const ring = Ring.make(3, HIT_LAYOUT);
    const pushed = Array.from({ length: 7 }, () => Ring.push(ring));
    expect(pushed).toStrictEqual([0, 1, 2, 0, 1, 2, 0]);
    expect(pushed.map((_, n) => Ring.slotOf(ring, n))).toStrictEqual(pushed);
  });

  it("pops the newest record's slot, and lowers both counts", () => {
    const ring = Ring.make(4, HIT_LAYOUT);
    pushHit(ring, 1.5, 10);
    pushHit(ring, 2.5, 20);
    pushHit(ring, 3.5, 30);
    expect([Ring.pop(ring), ring.written, ring.length]).toStrictEqual([
      2, 2, 2,
    ]);
    // The record is still there to read: a pop forgets it, and the next push cleans its slot.
    expect([ring.fields.x[2], ring.fields.amount[2]]).toStrictEqual([3.5, 30]);
    expect([Ring.pop(ring), ring.written, ring.length]).toStrictEqual([
      1, 1, 1,
    ]);
    expect([pushHit(ring, 4.5, 40), ring.written, ring.length]).toStrictEqual([
      [1, 0, 0],
      2,
      2,
    ]);
    expect([
      Ring.pop(ring),
      Ring.pop(ring),
      Ring.pop(ring),
      ring.written,
      ring.length,
    ]).toStrictEqual([1, 0, -1, 0, 0]);
  });

  it("pops `capacity` records after capacity + 1 pushes, and then -1", () => {
    const ring = Ring.make(3, HIT_LAYOUT);
    for (const amount of [10, 20, 30, 40]) {
      pushHit(ring, 0, amount);
    }
    // Newest first: records 3, 2 and 1. Record 0 was overwritten by record 3.
    const popped = [Ring.pop(ring), Ring.pop(ring), Ring.pop(ring)];
    expect(popped).toStrictEqual([0, 2, 1]);
    expect(popped.map((slot) => ring.fields.amount[slot])).toStrictEqual([
      40, 30, 20,
    ]);
    // One record was written and not popped, and it is not held any more.
    expect([ring.written, ring.length]).toStrictEqual([1, 0]);
    expect([Ring.pop(ring), ring.written, ring.length]).toStrictEqual([
      -1, 1, 0,
    ]);
    // The next record is number 1, in slot 1.
    expect([pushHit(ring, 0, 50), ring.written, ring.length]).toStrictEqual([
      [1, 0, 0],
      2,
      1,
    ]);
  });

  it("forgets every record on clear, and starts again at slot 0", () => {
    const ring = Ring.make(3, HIT_LAYOUT);
    for (const amount of [10, 20, 30, 40, 50]) {
      pushHit(ring, 0, amount);
    }
    Ring.clear(ring);
    expect([ring.written, ring.length, Ring.pop(ring)]).toStrictEqual([
      0, 0, -1,
    ]);
    // `clear` only forgets the counts: each slot is cleaned as `push` hands it out.
    expect([...ring.fields.amount]).toStrictEqual([40, 50, 30]);
    expect(pushHit(ring, 0, 60)).toStrictEqual([0, 0, 0]);
  });

  it("refuses a capacity that is not a whole number of 1 or more", () => {
    for (const capacity of [0, -1, 2.5, Number.NaN, Infinity]) {
      expect(() => Ring.make(capacity, HIT_LAYOUT)).toThrow(
        new RangeError(
          `Ring.make needs a whole capacity of 1 or more, got ${capacity}`
        )
      );
    }
    expect(Ring.make(1, HIT_LAYOUT).capacity).toBe(1);
  });
});

/** The records a reader takes from a ring now, by number. */
const taken = (
  reader: RingReader.RingReader,
  ring: Pick<Ring.Ring<Layout.Layout>, "capacity" | "written">
): number[] => {
  const numbers: number[] = [];
  for (let n = RingReader.take(reader, ring); n < ring.written; n++) {
    numbers.push(n);
  }
  return numbers;
};

const pushTimes = (ring: Ring.Ring<typeof HIT_LAYOUT>, times: number) => {
  for (let i = 0; i < times; i++) {
    Ring.push(ring);
  }
};

describe("a ring reader", () => {
  it("gives `written` on its first take: what was pushed before it looked is not taken", () => {
    const ring = Ring.make(4, HIT_LAYOUT);
    pushTimes(ring, 2);
    const reader = RingReader.make();
    expect(RingReader.take(reader, ring)).toBe(2);
    // And a ring nothing was pushed to starts at 0.
    expect(RingReader.take(RingReader.make(), Ring.make(4, HIT_LAYOUT))).toBe(
      0
    );
  });

  it("gives where it stopped, so each record is taken once", () => {
    const ring = Ring.make(4, HIT_LAYOUT);
    const reader = RingReader.make();
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
    const ring = Ring.make(4, HIT_LAYOUT);
    const reader = RingReader.make();
    pushTimes(ring, 1);
    expect(RingReader.take(reader, ring)).toBe(1);
    // Six more: records 1 and 2 were overwritten by 5 and 6 before the reader looked.
    pushTimes(ring, 6);
    expect(RingReader.take(reader, ring)).toBe(3);
    expect(RingReader.take(reader, ring)).toBe(7);
  });

  it("reads each record it takes from the slot `slotOf` gives", () => {
    const ring = Ring.make(3, HIT_LAYOUT);
    const reader = RingReader.make();
    RingReader.take(reader, ring);
    for (const amount of [10, 20, 30, 40, 50]) {
      pushHit(ring, 0, amount);
    }
    const amounts: number[] = [];
    for (let n = RingReader.take(reader, ring); n < ring.written; n++) {
      amounts.push(ring.fields.amount[Ring.slotOf(ring, n)]!);
    }
    expect(amounts).toStrictEqual([30, 40, 50]);
  });

  it("starts again at `written` for another ring", () => {
    const first = Ring.make(4, HIT_LAYOUT);
    const second = Ring.make(4, HIT_LAYOUT);
    const reader = RingReader.make();
    RingReader.take(reader, first);
    pushTimes(first, 2);
    // A new run's ring. By its counts alone it is the first one with a record to take: the
    // reader tells them apart by which object it is handed.
    pushTimes(second, 1);
    expect(RingReader.take(reader, second)).toBe(1);
    pushTimes(second, 2);
    expect(taken(reader, second)).toStrictEqual([1, 2]);
    // Back on the first, it starts again there too: it follows one ring at a time.
    expect(RingReader.take(reader, first)).toBe(2);
  });

  it("starts again at `written` after reset", () => {
    const ring = Ring.make(4, HIT_LAYOUT);
    const reader = RingReader.make();
    RingReader.take(reader, ring);
    pushTimes(ring, 2);
    RingReader.reset(reader);
    expect(RingReader.take(reader, ring)).toBe(2);
    pushTimes(ring, 1);
    expect(taken(reader, ring)).toStrictEqual([2]);
  });

  it("starts again at `written` when it finds a ring popped or cleared below what it took", () => {
    const ring = Ring.make(4, HIT_LAYOUT);
    const reader = RingReader.make();
    pushTimes(ring, 3);
    RingReader.take(reader, ring);
    Ring.pop(ring);
    expect(RingReader.take(reader, ring)).toBe(2);
    pushTimes(ring, 2);
    expect(taken(reader, ring)).toStrictEqual([2, 3]);
    Ring.clear(ring);
    expect(RingReader.take(reader, ring)).toBe(0);
    pushTimes(ring, 1);
    expect(taken(reader, ring)).toStrictEqual([0]);
  });

  it("leaves a second reader of the same ring where it was", () => {
    const ring = Ring.make(4, HIT_LAYOUT);
    const drawing = RingReader.make();
    const sound = RingReader.make();
    RingReader.take(drawing, ring);
    RingReader.take(sound, ring);
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
    const reader = RingReader.make();
    expect(RingReader.take(reader, counts)).toBe(5);
    counts.written = 9;
    expect(RingReader.take(reader, counts)).toBe(7);
  });
});

/** A level's cells: 1 in `tile` where a cell is a wall, and how high its ground is. */
const LEVEL_LAYOUT = { tile: Uint8Array, height: Float32Array };

/** A map from rows of text: `#` is a wall, and any other character is open ground. */
const mapOf = (
  rows: readonly string[]
): TileMap.TileMap<typeof LEVEL_LAYOUT> => {
  const map = TileMap.make(rows[0]!.length, rows.length, LEVEL_LAYOUT);
  for (const [row, text] of rows.entries()) {
    for (const [col, char] of [...text].entries()) {
      map.fields.tile[TileMap.cellAt(map, col, row)] = char === "#" ? 1 : 0;
    }
  }
  return map;
};

/** A mask as rows of text: `x` for a cell that is marked, `.` for one that is not. */
const marked = (
  map: TileMap.TileMap<typeof LEVEL_LAYOUT>,
  reached: Uint8Array
): string[] =>
  Array.from({ length: map.rows }, (_, row) =>
    Array.from({ length: map.cols }, (__, col) =>
      reached[TileMap.cellAt(map, col, row)] === 1 ? "x" : "."
    ).join("")
  );

/** A `passes` that accepts every cell. */
const everyCell = (): boolean => true;

/** The cell on each side of `cell`. */
const sidesOf = (map: TileMap.TileMap<typeof LEVEL_LAYOUT>, cell: number) => ({
  west: TileMap.neighbor(map, cell, TileMap.Side.west),
  east: TileMap.neighbor(map, cell, TileMap.Side.east),
  north: TileMap.neighbor(map, cell, TileMap.Side.north),
  south: TileMap.neighbor(map, cell, TileMap.Side.south),
});

describe("TileMap.make", () => {
  it("has one typed array of cols * rows for each field of its layout, every cell 0", () => {
    const map = TileMap.make(4, 3, LEVEL_LAYOUT);
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
    const map = TileMap.make(4, 3, LEVEL_LAYOUT);
    // The four corners, then one inside.
    expect([
      TileMap.cellAt(map, 0, 0),
      TileMap.cellAt(map, 3, 0),
      TileMap.cellAt(map, 0, 2),
      TileMap.cellAt(map, 3, 2),
      TileMap.cellAt(map, 2, 1),
    ]).toStrictEqual([0, 3, 8, 11, 6]);
    // Off the west, east, north and south edges. A column past the east edge is no cell of
    // the next row, which `row * cols + col` alone would give.
    expect([
      TileMap.cellAt(map, -1, 1),
      TileMap.cellAt(map, 4, 1),
      TileMap.cellAt(map, 1, -1),
      TileMap.cellAt(map, 1, 3),
    ]).toStrictEqual([-1, -1, -1, -1]);
  });

  it("gives a cell's column and its row back", () => {
    const map = TileMap.make(4, 3, LEVEL_LAYOUT);
    expect([TileMap.colOf(map, 6), TileMap.rowOf(map, 6)]).toStrictEqual([
      2, 1,
    ]);
    expect([TileMap.colOf(map, 11), TileMap.rowOf(map, 11)]).toStrictEqual([
      3, 2,
    ]);
    for (let cell = 0; cell < map.cells; cell++) {
      expect(
        TileMap.cellAt(map, TileMap.colOf(map, cell), TileMap.rowOf(map, cell))
      ).toBe(cell);
    }
  });

  it("numbers the sides west, east, north and south, with north the row above", () => {
    // A game that looks around a cell side by side does it in this order.
    expect(TileMap.Side).toStrictEqual({
      west: 0,
      east: 1,
      north: 2,
      south: 3,
    });
    const map = TileMap.make(4, 3, LEVEL_LAYOUT);
    expect(
      TileMap.rowOf(map, TileMap.neighbor(map, 5, TileMap.Side.north))
    ).toBe(TileMap.rowOf(map, 5) - 1);
  });

  it("gives the cell on each side, and -1 at each edge", () => {
    const map = TileMap.make(4, 3, LEVEL_LAYOUT);
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
      TileMap.neighbor(map, 3, TileMap.Side.east),
      TileMap.neighbor(map, 4, TileMap.Side.west),
    ]).toStrictEqual([-1, -1]);
  });

  it("gives -1 for the neighbour of no cell, and for a side that is none", () => {
    const map = TileMap.make(4, 3, LEVEL_LAYOUT);
    const nowhere = { west: -1, east: -1, north: -1, south: -1 };
    // So one lookup can follow another, with no test between them.
    expect(sidesOf(map, -1)).toStrictEqual(nowhere);
    // Nor of any other cell off the map: the one past the last is no cell of a fourth row, whose
    // neighbour above would be cell 8, and -4 none of a row above the first.
    expect(sidesOf(map, map.cells)).toStrictEqual(nowhere);
    expect(sidesOf(map, -4)).toStrictEqual(nowhere);
    expect(
      // @ts-expect-error -- a side is one of the four `Side` has, and 4 is none.
      TileMap.neighbor(map, 5, 4)
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
      expect(() => TileMap.make(cols, rows, LEVEL_LAYOUT)).toThrow(
        new RangeError(
          `TileMap.make needs a whole number of columns and of rows, 1 or more of each, got ${cols} by ${rows}`
        )
      );
    }
    expect(TileMap.make(1, 1, LEVEL_LAYOUT).cells).toBe(1);
  });

  describe("flood", () => {
    it("marks the start and what joins it by sides through passing cells, and counts them", () => {
      const map = mapOf(["..#.", ".#..", "#..."]);
      const { tile } = map.fields;
      const reached = new Uint8Array(map.cells);
      // The walls stop it, and a cell that only touches a marked one at a corner is not joined.
      expect(
        TileMap.flood(
          map,
          TileMap.cellAt(map, 0, 0),
          (cell) => tile[cell] === 0,
          reached
        )
      ).toBe(3);
      expect(marked(map, reached)).toStrictEqual(["xx..", "x...", "...."]);
    });

    it("stops at a cell `passes` refuses, and asks it of no cell it has marked", () => {
      const map = mapOf([".....", ".###.", "....."]);
      const { tile } = map.fields;
      const reached = new Uint8Array(map.cells);
      const asked: number[] = [];
      const count = TileMap.flood(
        map,
        TileMap.cellAt(map, 0, 1),
        (cell) => {
          asked.push(cell);
          // The middle column is closed too: the ring of open ground is cut at the top and
          // the bottom, so the east side is joined to the start by no passing cell.
          return tile[cell] === 0 && TileMap.colOf(map, cell) !== 2;
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
      const map = TileMap.make(4, 3, LEVEL_LAYOUT);
      const reached = new Uint8Array(map.cells);
      expect(TileMap.flood(map, 5, everyCell, reached)).toBe(12);
      expect(marked(map, reached)).toStrictEqual(["xxxx", "xxxx", "xxxx"]);
    });

    it("marks the start whatever `passes` says of it", () => {
      const map = mapOf(["#.."]);
      const { tile } = map.fields;
      const reached = new Uint8Array(map.cells);
      // From a wall: the wall, and the open ground beside it.
      expect(TileMap.flood(map, 0, (cell) => tile[cell] === 0, reached)).toBe(
        3
      );
      expect(marked(map, reached)).toStrictEqual(["xxx"]);
      // A start with nothing that passes around it is marked alone.
      reached.fill(0);
      expect(TileMap.flood(map, 2, () => false, reached)).toBe(1);
      expect(marked(map, reached)).toStrictEqual(["..x"]);
    });

    it("does not enter a cell already marked, so two floods share a mask", () => {
      const map = TileMap.make(5, 1, LEVEL_LAYOUT);
      const reached = new Uint8Array(map.cells);
      // The caller's mark in the middle cuts the row in two.
      reached[2] = 1;
      expect(TileMap.flood(map, 0, everyCell, reached)).toBe(2);
      expect(marked(map, reached)).toStrictEqual(["xxx.."]);
      // The second flood marks the other side, into the same mask.
      expect(TileMap.flood(map, 4, everyCell, reached)).toBe(2);
      expect(marked(map, reached)).toStrictEqual(["xxxxx"]);
    });

    it("marks nothing from a cell already marked, whichever flood marked it", () => {
      const map = TileMap.make(5, 1, LEVEL_LAYOUT);
      const reached = new Uint8Array(map.cells);
      reached[2] = 1;
      TileMap.flood(map, 0, everyCell, reached);
      // From a cell the flood marked, and from the one the caller marked: cells 3 and 4 are
      // beside it, and stay as they are.
      expect([
        TileMap.flood(map, 1, everyCell, reached),
        TileMap.flood(map, 2, everyCell, reached),
      ]).toStrictEqual([0, 0]);
      expect(marked(map, reached)).toStrictEqual(["xxx.."]);
    });

    it("marks nothing from a start off the map", () => {
      const map = TileMap.make(3, 2, LEVEL_LAYOUT);
      const reached = new Uint8Array(map.cells);
      // What `cellAt` and `neighbor` give off the map, and the cell past the last.
      expect([
        TileMap.flood(map, -1, everyCell, reached),
        TileMap.flood(map, map.cells, everyCell, reached),
      ]).toStrictEqual([0, 0]);
      expect(marked(map, reached)).toStrictEqual(["...", "..."]);
    });

    it("refuses a mask shorter than the map, wherever it starts, and marks nothing", () => {
      const map = TileMap.make(4, 3, LEVEL_LAYOUT);
      // A typed array drops a write past its end: given a row's worth of mask, a flood of this
      // open map would mark that row and count 4 cells of 12.
      const short = new Uint8Array(4);
      // From a cell the mask covers, one it doesn't, and one off the map.
      for (const start of [0, 6, -1]) {
        expect(() => TileMap.flood(map, start, everyCell, short)).toThrow(
          new RangeError(
            "TileMap.flood needs a reached mask as long as the map's 12 cells, got 4"
          )
        );
      }
      expect([...short]).toStrictEqual([0, 0, 0, 0]);
    });

    it("takes a mask longer than the map, and leaves what is past its cells", () => {
      const map = TileMap.make(4, 3, LEVEL_LAYOUT);
      const long = new Uint8Array(map.cells + 2);
      expect(TileMap.flood(map, 0, everyCell, long)).toBe(12);
      expect([...long.subarray(map.cells)]).toStrictEqual([0, 0]);
    });
  });
});

const OFFSET_BASIS = 0x81_1c_9d_c5;

/** The digest of `values`, folded in order by a state hash of their own. */
const digestOf = (...values: number[]): number => {
  const hash = StateHash.make();
  for (const value of values) {
    StateHash.add(hash, value);
  }
  return StateHash.digest(hash);
};

/** A list as a game writes one: a function that takes the `add` of whoever folds it. */
const visitOneTwo = (add: (value: number) => void) => {
  add(1);
  add(2);
};

describe("a state hash", () => {
  it("gives FNV-1a's offset basis with nothing folded in", () => {
    expect(StateHash.digest(StateHash.make())).toBe(OFFSET_BASIS);
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
    const hash = StateHash.make();
    const fold = () =>
      StateHash.digest(hash.pipe(StateHash.add(3), StateHash.add(0.25)));
    const first = fold();
    expect(first).not.toBe(OFFSET_BASIS);
    expect(StateHash.digest(StateHash.reset(hash))).toBe(OFFSET_BASIS);
    expect(fold()).toBe(first);
    // Without the reset, the second fold goes on from the first.
    expect(fold()).not.toBe(first);
  });

  it("folds a game's list through the `add` it is handed", () => {
    const hash = StateHash.make();
    visitOneTwo((value) => {
      StateHash.add(hash, value);
    });
    expect(StateHash.digest(hash)).toBe(digestOf(1, 2));
  });
});

/** Everything `EntityPool.visit` passes to its function, in order. */
const visited = <L extends Layout.Layout>(
  pool: EntityPool.EntityPool<L>
): number[] => {
  const values: number[] = [];
  EntityPool.visit(pool, (value) => {
    values.push(value);
  });
  return values;
};

describe("EntityPool.visit", () => {
  it("visits the count, then each field's live values in the layout's order, and nothing past the count", () => {
    const pool = EntityPool.make(4, { x: Float32Array, hp: Uint8Array });
    expect(visited(pool)).toStrictEqual([0]);
    for (const [x, hp] of [
      [1.5, 10],
      [2.5, 20],
      [3.5, 30],
    ] as const) {
      const i = EntityPool.add(pool);
      pool.fields.x[i] = x;
      pool.fields.hp[i] = hp;
    }
    expect(visited(pool)).toStrictEqual([3, 1.5, 2.5, 3.5, 10, 20, 30]);
    EntityPool.remove(pool, 0);
    // Slot 2 still holds what moved into slot 0. It is past the count, so it is not visited.
    expect([pool.fields.x[2], pool.fields.hp[2]]).toStrictEqual([3.5, 30]);
    expect(visited(pool)).toStrictEqual([2, 3.5, 2.5, 30, 20]);
  });

  it("visits the fields `Object.values` lists, in its order", () => {
    // An object's keys that are whole numbers come first, in ascending order, whatever the order
    // they were written in. A hash recorded over a pool depends on this order.
    const pool = EntityPool.make(2, {
      z: Float32Array,
      10: Uint8Array,
      x: Float32Array,
      2: Uint8Array,
    });
    for (const [z, ten, x, two] of [
      [1.5, 10, 2.5, 20],
      [3.5, 30, 4.5, 40],
    ] as const) {
      const i = EntityPool.add(pool);
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
    EntityPool.remove(pool, 0);
    // Ids 2 and 1 are live, in that order.
    expect(entries(pool)).toStrictEqual([
      [2, 30],
      [1, 20],
    ]);
    expect(visited(pool)).toStrictEqual([2, 30, 20]);
  });

  it("takes a state hash's `add` as its visit", () => {
    const pool = EntityPool.make(2, { x: Float32Array, hp: Uint8Array });
    const i = EntityPool.add(pool);
    pool.fields.x[i] = 1.5;
    pool.fields.hp[i] = 7;
    const hash = StateHash.make();
    EntityPool.visit(pool, (value) => {
      StateHash.add(hash, value);
    });
    expect(StateHash.digest(hash)).toBe(digestOf(1, 1.5, 7));
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
    const d = ExactMath.hypot2(xs[i]! - x, ys[i]! - y);
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
  SpatialGrid.make({ halfSize: 10, cellSize: 2, capacity });

describe("a spatial grid", () => {
  it("finds nearby points and skips distant ones", () => {
    const grid = SpatialGrid.make({ halfSize: 10, cellSize: 2, capacity: 3 });
    const xs = new Float32Array([0, 0.5, 9]);
    const ys = new Float32Array([0, 0.5, 9]);
    SpatialGrid.build(grid, xs, ys, 3);
    const out = new Int32Array(8);
    const found = [
      ...out.subarray(0, SpatialGrid.query(grid, 0, 0, 1, out)),
    ].toSorted();
    expect(found).toStrictEqual([0, 1]);
  });

  it("has no points before its first build", () => {
    const grid = makeGrid();
    const out = new Int32Array(4);
    expect([
      SpatialGrid.query(grid, 0, 0, 1, out),
      SpatialGrid.within(grid, 0, 0, 1, out),
      SpatialGrid.nearest(grid, 0, 0, 100),
    ]).toStrictEqual([0, 0, -1]);
  });

  it("refuses a build of more points than its capacity, and keeps the build it had", () => {
    const grid = makeGrid(2);
    SpatialGrid.build(grid, [0.5, 0.6], [0, 0], 2);
    // A third point has no place in the cells' lists: asked for it, the grid would never end.
    expect(() =>
      SpatialGrid.build(grid, [0.1, 0.2, 0.3], [0, 0, 0], 3)
    ).toThrow(
      new RangeError(
        "SpatialGrid.build needs a count within the grid's capacity of 2, got 3"
      )
    );
    expect(
      listed(8, (out) => SpatialGrid.query(grid, 0, 0, 1, out))
    ).toStrictEqual([1, 0]);
    expect(
      listed(8, (out) => SpatialGrid.within(grid, 0, 0, 1, out))
    ).toStrictEqual([1, 0]);
    expect(SpatialGrid.nearest(grid, 0, 0, 1)).toBe(0);
  });

  it("refuses a build with fewer radii than points, and keeps the build it had", () => {
    const grid = makeGrid();
    SpatialGrid.build(grid, [0.5], [0], 1);
    expect(() =>
      SpatialGrid.build(grid, [0.1, 0.2, 0.3], [0, 0, 0], 3, [1, 1])
    ).toThrow(
      new RangeError(
        "SpatialGrid.build needs a radius for each of its 3 points, got 2"
      )
    );
    expect(
      listed(8, (out) => SpatialGrid.within(grid, 0, 0, 1, out))
    ).toStrictEqual([0]);
    // More radii than points is a pool's field: the build reads its first `count`.
    SpatialGrid.build(grid, [0.1, 0.2, 0.3], [0, 0, 0], 2, [1, 1, 1]);
    expect(
      listed(8, (out) => SpatialGrid.within(grid, 0, 0, 1, out))
    ).toStrictEqual([1, 0]);
  });

  describe("within", () => {
    it("leaves out a point that query returns for the same circle", () => {
      const grid = makeGrid();
      // Both are in the cell the circle is in. The second is 2.7 from the centre.
      SpatialGrid.build(grid, [0.5, 1.9], [0.5, 1.9], 2);
      expect(
        listed(8, (out) => SpatialGrid.query(grid, 0, 0, 1, out))
      ).toStrictEqual([1, 0]);
      expect(
        listed(8, (out) => SpatialGrid.within(grid, 0, 0, 1, out))
      ).toStrictEqual([0]);
    });

    it("finds a wide point whose centre and cell are outside the circle's", () => {
      const grid = makeGrid();
      // The point is 5 from the centre, two cells past the circle's, with a radius of 4.5.
      SpatialGrid.build(grid, [5, 9], [0, 9], 2, [4.5, 0.5]);
      expect(
        listed(8, (out) => SpatialGrid.query(grid, 0, 0, 1, out))
      ).toStrictEqual([]);
      expect(
        listed(8, (out) => SpatialGrid.within(grid, 0, 0, 1, out))
      ).toStrictEqual([0]);
    });

    it("leaves out a circle that only touches", () => {
      const grid = makeGrid();
      // Each is 5 from the centre, a 3-4-5 triangle, so the lengths are exact.
      const xs = [3, -3, 5];
      const ys = [4, 4, 0];
      SpatialGrid.build(grid, xs, ys, 3, [4, 4.25, 3.75]);
      // 5 is not under 1 + 4, and is under 1 + 4.25.
      expect(
        listed(8, (out) => SpatialGrid.within(grid, 0, 0, 1, out))
      ).toStrictEqual([1]);
      SpatialGrid.build(grid, xs, ys, 3);
      expect(
        listed(8, (out) => SpatialGrid.within(grid, 0, 0, 5, out))
      ).toStrictEqual([]);
      expect(
        listed(8, (out) => SpatialGrid.within(grid, 0, 0, 5.25, out)).toSorted()
      ).toStrictEqual([0, 1, 2]);
    });

    it("returns the points in query's order: rows, then columns, then each cell's list", () => {
      const grid = makeGrid();
      // Four cells around the origin. Points 0, 3 and 5 share one, and 5 is too far.
      SpatialGrid.build(
        grid,
        [0.5, -0.5, 0.5, 0.6, -0.5, 1.9],
        [0.5, 0.5, -0.5, 0.6, -0.5, 1.9],
        6
      );
      expect(
        listed(8, (out) => SpatialGrid.query(grid, 0, 0, 1, out))
      ).toStrictEqual([4, 2, 1, 5, 3, 0]);
      expect(
        listed(8, (out) => SpatialGrid.within(grid, 0, 0, 1, out))
      ).toStrictEqual([4, 2, 1, 3, 0]);
    });

    it("gives the points a test of every candidate gives, in query's order", () => {
      const rng = Rng.make(81);
      const count = 300;
      const grid = SpatialGrid.make({
        halfSize: 10,
        cellSize: 2,
        capacity: count,
      });
      const xs = new Float32Array(count);
      const ys = new Float32Array(count);
      const radii = new Float64Array(count);
      // Some points are past the grid's edge, where they are kept in the edge cells.
      for (let i = 0; i < count; i++) {
        xs[i] = Rng.range(rng, -12, 12);
        ys[i] = Rng.range(rng, -12, 12);
        radii[i] = Rng.range(rng, 0, 1.5);
      }
      SpatialGrid.build(grid, xs, ys, count, radii);
      const widest = Math.max(...radii);
      let hits = 0;
      for (let q = 0; q < 200; q++) {
        const x = Rng.range(rng, -12, 12);
        const y = Rng.range(rng, -12, 12);
        const radius = Rng.range(rng, 0, 3);
        const expected = listed(count, (out) =>
          SpatialGrid.query(grid, x, y, radius + widest, out)
        ).filter(
          (i) => ExactMath.hypot2(xs[i]! - x, ys[i]! - y) < radius + radii[i]!
        );
        const everyPoint = Array.from({ length: count }, (_, i) => i).filter(
          (i) => ExactMath.hypot2(xs[i]! - x, ys[i]! - y) < radius + radii[i]!
        );
        expect(
          listed(count, (out) => SpatialGrid.within(grid, x, y, radius, out))
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
      SpatialGrid.build(grid, [-1.9, 0.5, 0.6, 0.7], [-1.9, 0.5, 0.6, 0.7], 4);
      // How many each found, then what it wrote.
      const two = new Int32Array(2);
      expect([SpatialGrid.query(grid, 0, 0, 1, two), ...two]).toStrictEqual([
        2, 0, 3,
      ]);
      expect([SpatialGrid.within(grid, 0, 0, 1, two), ...two]).toStrictEqual([
        2, 3, 2,
      ]);
      const four = new Int32Array(4).fill(-1);
      expect([SpatialGrid.within(grid, 0, 0, 1, four), ...four]).toStrictEqual([
        3, 3, 2, 1, -1,
      ]);
      expect(SpatialGrid.within(grid, 0, 0, 1, new Int32Array(0))).toBe(0);
    });

    it("tests a point where it is now, and finds it from the cell it was built in", () => {
      const grid = makeGrid();
      const xs = new Float32Array([1.5]);
      const ys = new Float32Array([0]);
      SpatialGrid.build(grid, xs, ys, 1);
      expect(
        listed(8, (out) => SpatialGrid.within(grid, 0, 0, 1, out))
      ).toStrictEqual([]);
      xs[0] = 0.5;
      expect(
        listed(8, (out) => SpatialGrid.within(grid, 0, 0, 1, out))
      ).toStrictEqual([0]);
      // Across the grid: the origin's circle no longer overlaps it, and no circle over there
      // visits the cell it was built in.
      xs[0] = 9;
      expect(
        listed(8, (out) => SpatialGrid.within(grid, 0, 0, 1, out))
      ).toStrictEqual([]);
      expect(
        listed(8, (out) => SpatialGrid.within(grid, 9, 0, 1, out))
      ).toStrictEqual([]);
    });

    it("tests a radius as it is now, and looks no further for it than the build's widest", () => {
      const grid = makeGrid();
      const xs = [5, 0.5];
      const ys = [0, 0];
      const radii = [0.5, 0.5];
      SpatialGrid.build(grid, xs, ys, 2, radii);
      expect(
        listed(8, (out) => SpatialGrid.within(grid, 0, 0, 1, out))
      ).toStrictEqual([1]);
      // Raised to reach the origin's circle, 5 away. From there the cells visited are those of
      // 1 plus the build's 0.5, so the point's cell is not among them.
      radii[0] = 4.5;
      expect(
        listed(8, (out) => SpatialGrid.within(grid, 0, 0, 1, out))
      ).toStrictEqual([1]);
      // A circle that visits its cell tests it with the radius it has now: 1.5 away, under 1 + 4.5.
      expect(
        listed(8, (out) => SpatialGrid.within(grid, 3.5, 0, 1, out))
      ).toStrictEqual([0]);
      // Built again, the origin's circle finds it.
      SpatialGrid.build(grid, xs, ys, 2, radii);
      expect(
        listed(8, (out) => SpatialGrid.within(grid, 0, 0, 1, out)).toSorted()
      ).toStrictEqual([0, 1]);
    });

    it("tests centres alone on a grid built without radii", () => {
      const grid = makeGrid();
      const xs = [3, 0.5];
      const ys = [0, 0];
      SpatialGrid.build(grid, xs, ys, 2, [2.5, 0]);
      expect(
        listed(8, (out) => SpatialGrid.within(grid, 0, 0, 1, out)).toSorted()
      ).toStrictEqual([0, 1]);
      // The same points, built again with no radii: the first is a centre 3 away.
      SpatialGrid.build(grid, xs, ys, 2);
      expect(
        listed(8, (out) => SpatialGrid.within(grid, 0, 0, 1, out))
      ).toStrictEqual([1]);
      // And no cell past the circle's is visited for it: moved into the circle, it is not found.
      xs[0] = 0.5;
      expect(
        listed(8, (out) => SpatialGrid.within(grid, 0, 0, 1, out))
      ).toStrictEqual([1]);
      SpatialGrid.build(grid, xs, ys, 2);
      expect(
        listed(8, (out) => SpatialGrid.within(grid, 0, 0, 1, out)).toSorted()
      ).toStrictEqual([0, 1]);
    });
  });

  describe("nearest", () => {
    it("gives -1 with nothing in range", () => {
      const grid = makeGrid();
      SpatialGrid.build(grid, [4], [0], 1);
      expect(SpatialGrid.nearest(grid, 0, 0, 3)).toBe(-1);
      expect(SpatialGrid.nearest(grid, 0, 0, 4.5)).toBe(0);
      SpatialGrid.build(grid, [], [], 0);
      expect(SpatialGrid.nearest(grid, 0, 0, 100)).toBe(-1);
    });

    it("leaves out a point at exactly its range", () => {
      const grid = makeGrid();
      // 5 from the origin, a 3-4-5 triangle, so the length is exact.
      SpatialGrid.build(grid, [3], [4], 1);
      expect(SpatialGrid.nearest(grid, 0, 0, 5)).toBe(-1);
      expect(SpatialGrid.nearest(grid, 0, 0, 5.25)).toBe(0);
    });

    it("gives the nearer of two points, whichever was built first", () => {
      const grid = makeGrid();
      SpatialGrid.build(grid, [1, 3], [0, 0], 2);
      expect(SpatialGrid.nearest(grid, 0, 0, 10)).toBe(0);
      SpatialGrid.build(grid, [3, 1], [0, 0], 2);
      expect(SpatialGrid.nearest(grid, 0, 0, 10)).toBe(1);
    });

    it("passes over a point whose skip is not 0", () => {
      const grid = makeGrid();
      SpatialGrid.build(grid, [1, 2, 3], [0, 0, 0], 3);
      const skip = new Uint8Array(3);
      expect(SpatialGrid.nearest(grid, 0, 0, 10, skip)).toBe(0);
      skip[0] = 1;
      expect(SpatialGrid.nearest(grid, 0, 0, 10, skip)).toBe(1);
      skip[1] = 2;
      expect(SpatialGrid.nearest(grid, 0, 0, 10, skip)).toBe(2);
      skip[2] = 1;
      expect(SpatialGrid.nearest(grid, 0, 0, 10, skip)).toBe(-1);
    });

    it("refuses a skip mask shorter than the build", () => {
      const grid = makeGrid();
      SpatialGrid.build(grid, [1, 2, 3], [0, 0, 0], 3);
      // Read past its end, a mask would pass over every point it does not cover.
      for (const skip of [[1, 0], []]) {
        expect(() => SpatialGrid.nearest(grid, 0, 0, 10, skip)).toThrow(
          new RangeError(
            `SpatialGrid.nearest needs a skip mask as long as the build's 3 points, got ${skip.length}`
          )
        );
      }
      // A longer one is a pool's field: what is past the build's count is not read.
      expect(SpatialGrid.nearest(grid, 0, 0, 10, [1, 0, 0, 1])).toBe(1);
      // And a grid with no points takes any mask.
      SpatialGrid.build(grid, [], [], 0);
      expect(SpatialGrid.nearest(grid, 0, 0, 10, [])).toBe(-1);
    });

    it("gives the lower index of two points at one distance, whichever was built first", () => {
      const grid = makeGrid();
      // In two cells: the one at -1 is visited first, whichever index it has.
      SpatialGrid.build(grid, [1, -1], [0, 0], 2);
      expect(SpatialGrid.nearest(grid, 0, 0, 10)).toBe(0);
      SpatialGrid.build(grid, [-1, 1], [0, 0], 2);
      expect(SpatialGrid.nearest(grid, 0, 0, 10)).toBe(0);
      // In one cell, whose list starts with the point built last.
      SpatialGrid.build(grid, [0.5, 0, 0.5], [0, 0.5, 0], 3);
      expect(SpatialGrid.nearest(grid, 0, 0, 10)).toBe(0);
      // And with the lower one skipped, the next.
      expect(SpatialGrid.nearest(grid, 0, 0, 10, [1, 0, 0])).toBe(1);
    });

    it("measures to a centre, whatever the point's radius", () => {
      const grid = makeGrid();
      // Point 0's circle reaches to 0.5 from the origin, and its centre is the farther one.
      SpatialGrid.build(grid, [3, 2], [0, 0], 2, [2.5, 0.125]);
      expect(SpatialGrid.nearest(grid, 0, 0, 10)).toBe(1);
      expect(SpatialGrid.nearest(grid, 0, 0, 2)).toBe(-1);
      expect(SpatialGrid.nearest(grid, 0, 0, 3, [0, 1])).toBe(-1);
      expect(SpatialGrid.nearest(grid, 0, 0, 3.5, [0, 1])).toBe(0);
    });

    it("agrees with a scan of every point, ties and skipped points included", () => {
      const rng = Rng.make(2026);
      const count = 300;
      const grid = SpatialGrid.make({
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
        xs[i] = Rng.int(rng, 25) - 12;
        ys[i] = Rng.int(rng, 25) - 12;
        skip[i] = Rng.int(rng, 4) === 0 ? 1 : 0;
      }
      SpatialGrid.build(grid, xs, ys, count);
      let found = 0;
      let ties = 0;
      for (let q = 0; q < 400; q++) {
        const x = Rng.int(rng, 25) - 12;
        const y = Rng.int(rng, 25) - 12;
        const range = Rng.range(rng, 0, 4);
        const expected = scanNearest(xs, ys, count, x, y, range, skip);
        expect(SpatialGrid.nearest(grid, x, y, range, skip)).toBe(expected);
        if (expected === -1) {
          continue;
        }
        found += 1;
        const best = ExactMath.hypot2(xs[expected]! - x, ys[expected]! - y);
        for (let i = expected + 1; i < count; i++) {
          if (
            skip[i] === 0 &&
            ExactMath.hypot2(xs[i]! - x, ys[i]! - y) === best
          ) {
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

describe("a fixed-step clock", () => {
  it("runs whole steps and carries the remainder", () => {
    // Powers of two, so the sums are exact in floating point.
    const clock = FixedStepClock.make({
      stepSeconds: 0.125,
      maxStepsPerFrame: 5,
    });
    let steps = 0;
    const count = () => {
      steps += 1;
    };
    expect(FixedStepClock.advance(clock, 0.3125, count)).toBe(2);
    expect(FixedStepClock.advance(clock, 0.0625, count)).toBe(1);
    expect(steps).toBe(3);
  });

  it("drops the backlog after a very long frame", () => {
    const clock = FixedStepClock.make({
      stepSeconds: 0.1,
      maxStepsPerFrame: 5,
    });
    expect(FixedStepClock.advance(clock, 10, () => {})).toBe(5);
    // Nothing carried over: half a step owes none.
    expect(FixedStepClock.advance(clock, 0.05, () => {})).toBe(0);
  });
});

describe("an event buffer", () => {
  it("drains in order and empties", () => {
    const events = EventBuffer.make<string>();
    EventBuffer.push(events, "a");
    EventBuffer.push(events, "b");
    expect(EventBuffer.drain(events)).toStrictEqual(["a", "b"]);
    expect(EventBuffer.drain(events)).toStrictEqual([]);
  });
});

// Each data type of core has Effect's shape (docs/code-style.md, "An Effect module"): a guard
// that knows it from a look-alike, `pipe`, a printed form that names it, and functions that take
// it first or, with one argument less, return the function a pipe applies.

const made = [
  [
    "EntityPool",
    EntityPool.make(2, { x: Float32Array }),
    EntityPool.isEntityPool,
  ],
  [
    "EntityPool.Identified",
    EntityPool.makeIdentified(2, { x: Float32Array }),
    EntityPool.isIdentified,
  ],
  ["EventBuffer", EventBuffer.make<string>(), EventBuffer.isEventBuffer],
  ["FixedStepClock", FixedStepClock.make(), FixedStepClock.isFixedStepClock],
  ["Ring", Ring.make(2, { x: Float32Array }), Ring.isRing],
  ["RingReader", RingReader.make(), RingReader.isRingReader],
  ["Rng", Rng.make(1), Rng.isRng],
  [
    "SpatialGrid",
    SpatialGrid.make({ halfSize: 1, cellSize: 1, capacity: 1 }),
    SpatialGrid.isSpatialGrid,
  ],
  ["StateHash", StateHash.make(), StateHash.isStateHash],
  ["TileMap", TileMap.make(2, 2, { tile: Uint8Array }), TileMap.isTileMap],
] as const;

describe("a data type of core", () => {
  it.each(made)("%s is known by its guard", (_name, value, guard) => {
    expect(guard(value)).toBe(true);
    // Its fields copied onto a plain object are not it, nor is anything else.
    expect([
      guard({ ...value }),
      guard(null),
      guard(1),
      guard([]),
    ]).toStrictEqual([false, false, false, false]);
  });

  it.each(made)("%s pipes", (_name, value) => {
    expect(value.pipe((self) => self)).toBe(value);
  });

  it.each(made)("%s prints as itself", (name, value) => {
    expect((value.toJSON() as { readonly _id: string })._id).toBe(name);
    expect(String(value)).toContain(name);
  });

  it("is told apart from the other kinds", () => {
    const pool = EntityPool.make(2, { x: Float32Array });
    expect([
      EntityPool.isIdentified(pool),
      Ring.isRing(pool),
      TileMap.isTileMap(Ring.make(2, { x: Float32Array })),
    ]).toStrictEqual([false, false, false]);
  });

  it("is changed by a function given it last, through pipe, as when given it first", () => {
    const first = EntityPool.makeIdentified(4, { x: Float32Array });
    const last = EntityPool.makeIdentified(4, { x: Float32Array });
    for (const pool of [first, last]) {
      EntityPool.add(pool);
      EntityPool.add(pool);
      EntityPool.add(pool);
    }
    EntityPool.remove(first, 0);
    last.pipe(EntityPool.remove(0));
    expect([EntityPool.idOf(last, 0), last.count]).toStrictEqual([
      EntityPool.idOf(first, 0),
      first.count,
    ]);
    const hash = StateHash.make().pipe(StateHash.add(1), StateHash.add(2));
    expect(StateHash.digest(hash)).toBe(digestOf(1, 2));
    const draws = Rng.make(5).pipe(Rng.range(16, 22));
    expect(draws).toBe(Rng.range(Rng.make(5), 16, 22));
  });
});

describe("the functions of numbers", () => {
  it("take their first operand last, through pipe, and give the same bits", () => {
    expect([
      ExactMath.clamp(0, 1)(1.5),
      ExactMath.lerp(20, 0.25)(10),
      ExactMath.hypot2(4)(3),
      ExactMath.powInt(4)(0.9),
      ExactMath.hashCell(7)(3),
      Timer.countDown(1 / 60)(0.15),
      Tween.progress(10, 4)(11),
    ]).toStrictEqual([
      ExactMath.clamp(1.5, 0, 1),
      ExactMath.lerp(10, 20, 0.25),
      ExactMath.hypot2(3, 4),
      ExactMath.powInt(0.9, 4),
      ExactMath.hashCell(3, 7),
      Timer.countDown(0.15, 1 / 60),
      Tween.progress(11, 10, 4),
    ]);
  });
});
