import { Data, Effect, Exit, Random as EffectRandom, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import { Rng } from "../src/ecs/random";
import { World as EcsWorld } from "../src/ecs/world";
import {
  Action,
  App,
  Commands,
  Component,
  Field,
  Query,
  Random,
  Script,
  System,
} from "../src/index";

const withApp = <T, A>(
  make: Effect.Effect<T, never, Scope.Scope>,
  use: (app: T) => A
): A => Effect.runSync(Effect.scoped(Effect.map(make, use)));

const draws = (rng: Rng, count: number): number[] =>
  Array.from({ length: count }, () => rng.bits());

/**
 * xoshiro128** as its authors publish it, written the slow and obvious way
 * with BigInt so that nothing depends on how 32-bit arithmetic is spelled.
 */
const reference = (state: readonly number[]) => {
  const mask = 0xff_ff_ff_ffn;
  const rotl = (x: bigint, k: bigint) => ((x << k) | (x >> (32n - k))) & mask;
  const s = state.map((word) => BigInt(word));

  return (): number => {
    const result = (rotl((s[1]! * 5n) & mask, 7n) * 9n) & mask;
    const t = (s[1]! << 9n) & mask;
    s[2]! ^= s[0]!;
    s[3]! ^= s[1]!;
    s[1]! ^= s[2]!;
    s[0]! ^= s[3]!;
    s[2]! ^= t;
    s[3] = rotl(s[3]!, 11n);

    return Number(result);
  };
};

const KNOWN_FIRST_DRAWS_OF_SEED_1 = [
  393_288_148, 4_155_725_614, 3_709_563_501, 954_221_178,
];

describe("the random number generator", () => {
  it("gives the same numbers for the same seed, and different ones for another", () => {
    expect(draws(new Rng(42), 100)).toStrictEqual(draws(new Rng(42), 100));
    expect(draws(new Rng(42), 100)).not.toStrictEqual(draws(new Rng(43), 100));
    // No seed is seed 0, so a game is repeatable until it asks not to be.
    expect(draws(new Rng(), 10)).toStrictEqual(draws(new Rng(0), 10));
  });

  it("gives a different sequence for every seed, close together or far apart", () => {
    const seeds = [
      ...Array.from({ length: 2000 }, (_, i) => i),
      // Seeds that differ only above 32 bits, as two clock readings can.
      ...Array.from({ length: 2000 }, (_, i) => i * 4_294_967_296),
      1_763_238_000_000,
      1_763_238_000_001,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER - 1,
    ];

    const starts = new Set(seeds.map((seed) => new Rng(seed).state.join(",")));
    expect(starts.size).toBe(new Set(seeds).size);
    const firsts = new Set(seeds.map((seed) => draws(new Rng(seed), 2).join()));
    expect(firsts.size).toBe(new Set(seeds).size);
    // The one state the generator could never leave.
    expect(starts.has("0,0,0,0")).toBe(false);
  });

  it("matches the published algorithm, bit for bit, from any state", () => {
    for (const seed of [0, 1, 7, 2 ** 31, 2 ** 32, 2 ** 40 + 12_345]) {
      const rng = new Rng(seed);
      const expected = reference([...rng.state]);

      for (let i = 0; i < 2000; i += 1) {
        expect(rng.bits()).toBe(expected());
      }
    }

    // The first numbers of seed 1, written down. A change here changes every
    // game ever recorded with a seed, so it has to be meant.
    expect(draws(new Rng(1), 4)).toStrictEqual(KNOWN_FIRST_DRAWS_OF_SEED_1);
  });

  it("refuses a seed that is not a whole number from 0 up", () => {
    for (const seed of [-1, 0.5, Number.NaN, Infinity, 2 ** 53]) {
      expect(() => new Rng(seed)).toThrow(
        /random seed must be a whole number/u
      );
    }

    expect(() => new EcsWorld({ seed: -1 })).toThrow(/random seed/u);
    const rng = new Rng(5);
    rng.bits();
    rng.seed(5);
    expect(draws(rng, 5)).toStrictEqual(draws(new Rng(5), 5));
  });

  it("resumes from a copy of its state", () => {
    const rng = new Rng(9);
    draws(rng, 17);
    const saved = Uint32Array.from(rng.state);
    const expected = draws(rng, 50);
    const restored = new Rng(1234);
    restored.state.set(saved);
    expect(draws(restored, 50)).toStrictEqual(expected);
    // The state is all there is: four 32-bit numbers.
    expect(rng.state).toHaveLength(4);
    expect(rng.state).toBeInstanceOf(Uint32Array);
  });

  it("next() is a number from 0 up to, never reaching, 1, spread evenly", () => {
    const rng = new Rng(3);
    const buckets = Array.from({ length: 10 }, () => 0);
    let sum = 0;

    for (let i = 0; i < 100_000; i += 1) {
      const value = rng.next();
      expect(value >= 0 && value < 1).toBe(true);
      buckets[Math.floor(value * 10)]! += 1;
      sum += value;
    }

    expect(sum / 100_000).toBeCloseTo(0.5, 2);

    for (const count of buckets) {
      expect(count).toBeGreaterThan(9500);
      expect(count).toBeLessThan(10_500);
    }

    // One draw of 32 bits, divided by 2^32: exact, so it is the same everywhere.
    const a = new Rng(8);
    const b = new Rng(8);
    expect(a.next()).toBe(b.bits() / 2 ** 32);
  });

  it("int() includes both ends and gives every value equal odds", () => {
    const rng = new Rng(11);
    const counts = new Map<number, number>();

    for (let i = 0; i < 60_000; i += 1) {
      const roll = rng.int(1, 6);
      counts.set(roll, (counts.get(roll) ?? 0) + 1);
    }

    expect([...counts.keys()].sort()).toStrictEqual([1, 2, 3, 4, 5, 6]);

    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(9600);
      expect(count).toBeLessThan(10_400);
    }

    expect(rng.int(5, 5)).toBe(5);
    const negatives = Array.from({ length: 200 }, () => rng.int(-2, 1));
    expect(new Set(negatives)).toStrictEqual(new Set([-2, -1, 0, 1]));
    // The widest range it takes is all 2^32 values.
    const wide = rng.int(0, 2 ** 32 - 1);
    expect(Number.isInteger(wide) && wide >= 0 && wide < 2 ** 32).toBe(true);
    expect(rng.int(-(2 ** 31), 2 ** 31 - 1)).toBeLessThan(2 ** 31);
  });

  it("int() is not skewed towards low values by a range that does not divide 2^32", () => {
    // With a range of 3 * 2^30, taking 32 bits modulo the range would give
    // the lowest third of the values twice the odds of the rest.
    const rng = new Rng(21);
    const top = 3 * 2 ** 30 - 1;
    let low = 0;
    const total = 30_000;

    for (let i = 0; i < total; i += 1) {
      if (rng.int(0, top) < 2 ** 30) {
        low += 1;
      }
    }

    expect(low / total).toBeGreaterThan(0.31);
    expect(low / total).toBeLessThan(0.36);
  });

  it("int() refuses a range it cannot serve", () => {
    const rng = new Rng(1);
    expect(() => rng.int(6, 1)).toThrow(/Random\.int\(6, 1\)/u);
    expect(() => rng.int(0.5, 3)).toThrow(/whole numbers/u);
    expect(() => rng.int(0, 2.5)).toThrow(/whole numbers/u);
    expect(() => rng.int(0, 2 ** 32)).toThrow(/no more than 2\^32 - 1 above/u);
    expect(() => rng.int(Number.NaN, 3)).toThrow(/whole numbers/u);
    // A refused call draws nothing.
    expect(draws(rng, 3)).toStrictEqual(draws(new Rng(1), 3));
  });

  it("pick() returns each item about as often as any other, and refuses an empty list", () => {
    const rng = new Rng(4);
    const items = ["a", "b", "c", "d"] as const;
    const counts: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 };

    for (let i = 0; i < 40_000; i += 1) {
      counts[rng.pick(items)]! += 1;
    }

    for (const item of items) {
      expect(counts[item]).toBeGreaterThan(9600);
      expect(counts[item]).toBeLessThan(10_400);
    }

    expect(rng.pick(["only"])).toBe("only");
    expect(rng.pick(Float32Array.of(1.5))).toBe(1.5);
    expect(() => rng.pick([])).toThrow(/empty list/u);
  });

  it("shuffle() reorders an array in place, into every order equally often", () => {
    const rng = new Rng(6);
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const returned = rng.shuffle(items);
    expect(returned).toBe(items);
    expect([...items].sort()).toStrictEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(items).not.toStrictEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    const orders = new Map<string, number>();

    for (let i = 0; i < 24_000; i += 1) {
      const order = rng.shuffle(["a", "b", "c", "d"]).join("");
      orders.set(order, (orders.get(order) ?? 0) + 1);
    }

    expect(orders.size).toBe(24);

    for (const count of orders.values()) {
      expect(count).toBeGreaterThan(850);
      expect(count).toBeLessThan(1150);
    }

    expect(rng.shuffle([])).toStrictEqual([]);
    expect(rng.shuffle(["one"])).toStrictEqual(["one"]);

    // The same seed shuffles the same way.
    const order = (seed: number) =>
      new Rng(seed).shuffle(Array.from({ length: 20 }, (_, i) => i));

    expect(order(77)).toStrictEqual(order(77));
    expect(order(77)).not.toStrictEqual(order(78));
  });
});

// --- a small game that leans on randomness everywhere --------------------------

const Die = Component.define("rnd/Die", { face: Field.u8, rolls: Field.u32 });
const Spark = Component.define("rnd/Spark", { x: Field.f32, y: Field.f32 });

const Roll = Action.define("rnd/Roll", Schema.Struct({ sides: Schema.Int }));

class NoSuchDie extends Data.TaggedError("NoSuchDie")<{}> {}

/** A handler that draws: the die's new face is random. */
const roll = Action.handler(Roll, function* ({ sides }) {
  const random = yield* Random;
  const dice = yield* Query.all(Die);

  if (dice.count() === 0) {
    return yield* Effect.fail(new NoSuchDie());
  }

  let face = 0;
  dice.each((die) => {
    die.face = random.int(1, sides);
    die.rolls += 1;
    face = die.face;
  });

  return face;
});

/** A system that draws inside its loop, and spawns a random number of things. */
const Sparks = System.make("Sparks", function* () {
  const random = yield* Random;
  const commands = yield* Commands;
  const sparks = yield* Query.all(Spark);
  sparks.each((spark, entity) => {
    spark.x += random.next() - 0.5;
    spark.y += random.next() - 0.5;

    if (random.int(1, 10) === 1) {
      commands.despawn(entity);
    }
  });
  const born = random.int(0, 3);

  for (let i = 0; i < born; i += 1) {
    commands.spawn(Spark.of({ x: random.next(), y: random.next() }));
  }
});

/** A script that draws between waits. */
const Gambler = Effect.gen(function* () {
  const random = yield* Random;
  const script = yield* Script;
  const actions = yield* Action.Actions;

  for (;;) {
    yield* script.sleep(random.pick([1, 2, 3]));
    actions.enqueue(Roll, { sides: random.pick([6, 20]) });
  }
});

const play = (seed: number | undefined, ticks: number) =>
  withApp(
    App.make({
      systems: [Sparks],
      handlers: [roll],
      ...(seed === undefined ? {} : { seed }),
    }),
    (app) => {
      app.world.spawn(Die.of({ face: 1, rolls: 0 }));
      app.spawnScript(Gambler);

      for (let i = 0; i < ticks; i += 1) {
        if (i % 7 === 3) {
          app.dispatch(Roll, { sides: 6 });
        }

        app.tick(1);
      }

      return snapshot(app);
    }
  );

const snapshot = (app: App.Any) => {
  const sparks: [number, number, number][] = [];
  app.world.view(Query.all(Spark)).each((spark, entity) => {
    sparks.push([entity, spark.x, spark.y]);
  });
  const dice: [number, number][] = [];
  app.world.view(Query.all(Die)).each((die) => {
    dice.push([die.face, die.rolls]);
  });

  return {
    sparks,
    dice,
    log: app.actionLog,
    generator: [...app.world.random.state],
  };
};

describe("the Random service", () => {
  it("is the world's generator, so its state is part of the world", () => {
    let seen: Rng | undefined;

    const Probe = System.make("Probe", function* () {
      seen = yield* Random;
    });

    withApp(App.make({ systems: [Probe], seed: 5 }), (app) => {
      app.tick(1);
      expect(seen).toBe(app.world.random);
      expect([...app.world.random.state]).toStrictEqual([...new Rng(5).state]);
    });
    expect(Random.key).toBe("arcadekit/Random");
  });

  it("makes two apps with one seed agree, and two seeds differ", () => {
    const first = play(2024, 120);
    const second = play(2024, 120);
    expect(second).toStrictEqual(first);
    // The game really is random: it rolled, spawned and moved things.
    expect(first.sparks.length).toBeGreaterThan(0);
    expect(first.dice[0]![1]).toBeGreaterThan(20);
    // The script's rolls are the simulation's own, so only the moves made
    // from outside are in the log.
    expect(first.log.length).toBeGreaterThan(15);

    const other = play(2025, 120);
    expect(other.generator).not.toStrictEqual(first.generator);
    expect(other.sparks).not.toStrictEqual(first.sparks);
    expect(other.log).not.toStrictEqual(first.log);
    // Leaving the seed out is seed 0, not a different game each time.
    expect(play(undefined, 60)).toStrictEqual(play(0, 60));
    expect(play(undefined, 60)).toStrictEqual(play(undefined, 60));
  });

  it("lets a game that uses it replay identically from its log", () => {
    // The script's rolls are in the log as actions, so the replay runs the
    // systems and the handler but not the script, and must still draw the
    // same numbers in the same order to end in the same state.
    const record = (seed: number) =>
      withApp(
        App.make({ systems: [Sparks], handlers: [roll], seed }),
        (app) => {
          app.world.spawn(Die.of({ face: 1, rolls: 0 }));
          const other = new Rng(seed + 1000);

          for (let i = 0; i < 150; i += 1) {
            if (other.int(1, 4) === 1) {
              app.dispatch(Roll, { sides: other.pick([4, 6, 8, 12]) });
            }

            app.tick(1 / 60);
          }

          return snapshot(app);
        }
      );

    const replayOf = (recorded: ReturnType<typeof record>, seed: number) =>
      withApp(
        App.make({ systems: [Sparks], handlers: [roll], seed }),
        (app) => {
          app.world.spawn(Die.of({ face: 1, rolls: 0 }));
          // Through text and back, as a save file would be.
          const loaded = Action.decodeLog(Action.encodeLog(recorded.log));

          if (Exit.isFailure(loaded)) {
            throw new Error("the log did not survive being written down");
          }

          App.replay(app, loaded.value, { delta: 1 / 60, ticks: 150 });

          return snapshot(app);
        }
      );

    const recorded = record(31);
    expect(recorded.dice[0]![1]).toBeGreaterThan(10);
    expect(recorded.sparks.length).toBeGreaterThan(0);
    expect(replayOf(recorded, 31)).toStrictEqual(recorded);
    // With another seed the same moves would be a different game, and the
    // replay says so before its first tick.
    expect(() => replayOf(recorded, 32)).toThrow(App.ReplayDiverged);
    expect(() => replayOf(recorded, 32)).toThrow(
      /the world's hash at tick 0 .* check the seed/u
    );
  });

  it("refuses a bad seed when the app is made", () => {
    expect(() => withApp(App.make({ seed: 1.5 }), () => 0)).toThrow(
      /random seed must be a whole number/u
    );
  });

  it("seeds Effect's own Random inside the app too", () => {
    const run = (seed: number) =>
      withApp(App.make({ seed }), (app) => {
        const out: number[] = [];
        const before = [...app.world.random.state];
        app.spawnScript(
          Effect.gen(function* () {
            out.push(yield* EffectRandom.next);
            out.push(yield* EffectRandom.nextInt);
            out.push(yield* EffectRandom.nextIntBetween(1, 6));
            out.push(...(yield* EffectRandom.shuffle([1, 2, 3, 4, 5])));
            // The two are one generator: this continues the same sequence.
            out.push((yield* Random).bits());
          })
        );
        // It drew from the world's generator, not from one of its own.
        expect([...app.world.random.state]).not.toStrictEqual(before);

        return out;
      });

    const first = run(8);
    expect(run(8)).toStrictEqual(first);
    expect(run(9)).not.toStrictEqual(first);
    expect(first[0]! >= 0 && first[0]! < 1).toBe(true);
    expect(Number.isSafeInteger(first[1])).toBe(true);
    expect(first[2]! >= 1 && first[2]! <= 6).toBe(true);

    // Its floats use all 53 bits and its integers both signs.
    withApp(App.make({ seed: 3 }), (app) => {
      const floats: number[] = [];
      const ints: number[] = [];
      app.spawnScript(
        Effect.gen(function* () {
          for (let i = 0; i < 2000; i += 1) {
            floats.push(yield* EffectRandom.next);
            ints.push(yield* EffectRandom.nextInt);
          }
        })
      );
      expect(floats.every((value) => value >= 0 && value < 1)).toBe(true);
      expect(floats.some((value) => (value * 2 ** 32) % 1 !== 0)).toBe(true);
      const mean = floats.reduce((sum, value) => sum + value, 0) / 2000;
      expect(mean).toBeGreaterThan(0.47);
      expect(mean).toBeLessThan(0.53);
      expect(ints.every((value) => Number.isSafeInteger(value))).toBe(true);
      expect(ints.some((value) => value < 0)).toBe(true);
      expect(ints.some((value) => value > 2 ** 40)).toBe(true);
      expect(ints.some((value) => value < -(2 ** 40))).toBe(true);
      expect(ints.some((value) => Math.abs(value) < 2 ** 50)).toBe(true);
    });
  });
});
