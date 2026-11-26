import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Random as EffectRandom, Exit, Schema } from "effect";

import { Rng } from "../src/ecs/random.ts";
import { World as EcsWorld } from "../src/ecs/world.ts";
import {
  Action,
  App,
  Commands,
  Component,
  Field,
  Plugin,
  Query,
  Random,
  Replay,
  Singleton,
  System,
  World,
} from "../src/index.ts";
import type { Entity } from "../src/index.ts";
import { thrown, unwrap } from "./checks.ts";

const withApp = <T, A, E = never, E2 = never>(
  make: Effect.Effect<T, E>,
  use: (app: T) => Effect.Effect<A, E2>
) => Effect.flatMap(make, use);

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
    expect(draws(new Rng(42), 100)).toEqual(draws(new Rng(42), 100));
    expect(draws(new Rng(42), 100)).not.toEqual(draws(new Rng(43), 100));
    // No seed is seed 0, so a game is repeatable until it asks not to be.
    expect(draws(new Rng(), 10)).toEqual(draws(new Rng(0), 10));
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
      const expected = reference(Array.from(rng.state));
      for (let i = 0; i < 2000; i++) {
        expect(rng.bits()).toBe(expected());
      }
    }
    // The first numbers of seed 1, written down. A change here changes every
    // game ever recorded with a seed, so it has to be meant.
    expect(draws(new Rng(1), 4)).toEqual(KNOWN_FIRST_DRAWS_OF_SEED_1);
  });

  it("refuses a seed that is not a whole number from 0 up", () => {
    for (const seed of [-1, 0.5, Number.NaN, Infinity, 2 ** 53]) {
      expect(() => new Rng(seed)).toThrow(/random seed must be a whole number/);
    }
    expect(() => new EcsWorld({ seed: -1 })).toThrow(/random seed/);
    const rng = new Rng(5);
    rng.bits();
    rng.seed(5);
    expect(draws(rng, 5)).toEqual(draws(new Rng(5), 5));
  });

  it("resumes from a copy of its state", () => {
    const rng = new Rng(9);
    draws(rng, 17);
    const saved = Uint32Array.from(rng.state);
    const expected = draws(rng, 50);
    const restored = new Rng(1234);
    restored.state.set(saved);
    expect(draws(restored, 50)).toEqual(expected);
    // The state is all there is: four 32-bit numbers.
    expect(rng.state.length).toBe(4);
    expect(rng.state).toBeInstanceOf(Uint32Array);
  });

  it("next() is a number from 0 up to, never reaching, 1, spread evenly", () => {
    const rng = new Rng(3);
    const buckets = Array.from({ length: 10 }, () => 0);
    let sum = 0;
    for (let i = 0; i < 100_000; i++) {
      const value = rng.next();
      expect(value >= 0 && value < 1).toBe(true);
      buckets[Math.floor(value * 10)]!++;
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
    for (let i = 0; i < 60_000; i++) {
      const roll = rng.int(1, 6);
      counts.set(roll, (counts.get(roll) ?? 0) + 1);
    }
    expect([...counts.keys()].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(9600);
      expect(count).toBeLessThan(10_400);
    }
    expect(rng.int(5, 5)).toBe(5);
    const negatives = Array.from({ length: 200 }, () => rng.int(-2, 1));
    expect(new Set(negatives)).toEqual(new Set([-2, -1, 0, 1]));
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
    for (let i = 0; i < total; i++) {
      if (rng.int(0, top) < 2 ** 30) {
        low++;
      }
    }
    expect(low / total).toBeGreaterThan(0.31);
    expect(low / total).toBeLessThan(0.36);
  });

  it("int() refuses a range it cannot serve", () => {
    const rng = new Rng(1);
    expect(() => rng.int(6, 1)).toThrow(/Random\.int\(6, 1\)/);
    expect(() => rng.int(0.5, 3)).toThrow(/whole numbers/);
    expect(() => rng.int(0, 2.5)).toThrow(/whole numbers/);
    expect(() => rng.int(0, 2 ** 32)).toThrow(/no more than 2\^32 - 1 above/);
    expect(() => rng.int(Number.NaN, 3)).toThrow(/whole numbers/);
    // A refused call draws nothing.
    expect(draws(rng, 3)).toEqual(draws(new Rng(1), 3));
  });

  it("pick() returns each item about as often as any other, and refuses an empty list", () => {
    const rng = new Rng(4);
    const items = ["a", "b", "c", "d"] as const;
    const counts: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 };
    for (let i = 0; i < 40_000; i++) {
      counts[rng.pick(items)]!++;
    }
    for (const item of items) {
      expect(counts[item]).toBeGreaterThan(9600);
      expect(counts[item]).toBeLessThan(10_400);
    }
    expect(rng.pick(["only"])).toBe("only");
    expect(rng.pick(Float32Array.of(1.5))).toBe(1.5);
    expect(() => rng.pick([])).toThrow(/empty list/);
  });

  it("shuffle() reorders an array in place, into every order equally often", () => {
    const rng = new Rng(6);
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const returned = rng.shuffle(items);
    expect(returned).toBe(items);
    expect([...items].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(items).not.toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    const orders = new Map<string, number>();
    for (let i = 0; i < 24_000; i++) {
      const order = rng.shuffle(["a", "b", "c", "d"]).join("");
      orders.set(order, (orders.get(order) ?? 0) + 1);
    }
    expect(orders.size).toBe(24);
    for (const count of orders.values()) {
      expect(count).toBeGreaterThan(850);
      expect(count).toBeLessThan(1150);
    }
    expect(rng.shuffle([])).toEqual([]);
    expect(rng.shuffle(["one"])).toEqual(["one"]);
    // The same seed shuffles the same way.
    const order = (seed: number) =>
      new Rng(seed).shuffle(Array.from({ length: 20 }, (_, i) => i));
    expect(order(77)).toEqual(order(77));
    expect(order(77)).not.toEqual(order(78));
  });
});

// --- a small game that leans on randomness everywhere --------------------------

const Die = Component.define("rnd/Die", { face: Field.u8, rolls: Field.u32 });
const Spark = Component.define("rnd/Spark", { x: Field.f32, y: Field.f32 });

class NoSuchDie extends Schema.TaggedError<NoSuchDie>()("NoSuchDie", {}) {}
const Roll = Action.define("rnd/Roll", Schema.Struct({ sides: Schema.Int }), {
  error: NoSuchDie,
});

/** A handler that draws: the die's new face is random. */
const roll = Action.handler(Roll, function* ({ sides }) {
  const random = yield* Random;
  const dice = yield* Query.all(Die).pipe(Query.writes(Die));
  if (dice.count() === 0) {
    return yield* NoSuchDie.make({});
  }
  let face = 0;
  dice.each((die) => {
    die.face = random.int(1, sides);
    die.rolls++;
    face = die.face;
  });
  return face;
});

/** A system that draws inside its loop, and spawns a random number of things. */
const Sparks = System.tick("Sparks", function* () {
  const random = yield* Random;
  const commands = yield* Commands.spawns(Spark);
  const sparks = yield* Query.all(Spark).pipe(Query.writes(Spark));
  sparks.each((spark, entity) => {
    spark.x += random.next() - 0.5;
    spark.y += random.next() - 0.5;
    if (random.int(1, 10) === 1) {
      commands.despawn(entity);
    }
  });
  const born = random.int(0, 3);
  for (let i = 0; i < born; i++) {
    commands.spawn(Spark.of({ x: random.next(), y: random.next() }));
  }
});

/** The ticks the gambler waits before its next roll. */
const Wait = Singleton.define("rnd/Wait", { left: Field.u8 }, { left: 0 });

/** A system that draws between waits, and keeps its wait in the world. */
const Gambler = System.tick("Gambler", function* () {
  const random = yield* Random;
  const wait = yield* Wait.writes;
  if (wait.left > 1) {
    wait.left -= 1;
    return;
  }
  if (wait.left === 1) {
    (yield* Action.Actions).enqueue(Roll, { sides: random.pick([6, 20]) });
  }
  wait.left = random.pick([1, 2, 3]);
});

/** The game starts with one die. */
const Begin = Plugin.make("rnd/Begin", {
  setup: Effect.map(Commands.spawns(Die), (commands) => {
    commands.spawn(Die.of({ face: 1, rolls: 0 }));
  }),
});

const play = Effect.fnUntraced(function* (
  seed: number | undefined,
  ticks: number
) {
  return yield* withApp(
    App.make(
      App.define({
        plugins: [Begin],
        systems: [Sparks, Gambler],
        handlers: [roll],
      }),
      seed === undefined ? {} : { seed }
    ),
    (app) =>
      Effect.gen(function* () {
        for (let i = 0; i < ticks; i++) {
          if (i % 7 === 3) {
            yield* app.dispatch(Roll, { sides: 6 });
          }
          yield* app.tick(1);
        }
        return yield* snapshot(app);
      })
  );
});

const snapshot = Effect.fnUntraced(function* (app: App.Any) {
  const sparks: [Entity, number, number][] = [];
  const dice: [number, number][] = [];
  const hash = yield* app.read(
    Effect.gen(function* () {
      (yield* Query.all(Spark)).each((spark, entity) => {
        sparks.push([entity, spark.x, spark.y]);
      });
      (yield* Query.all(Die)).each((die) => {
        dice.push([die.face, die.rolls]);
      });
      // It covers the generator's state, which is part of the world.
      return (yield* World).hash();
    })
  );
  return {
    sparks,
    dice,
    log: app.actionLog,
    recording: yield* Replay.record(app),
    hash,
  };
});

describe("the Random service", () => {
  it.effect("is the world's generator, so its state is part of the world", () =>
    Effect.gen(function* () {
      let seen: number[] = [];
      let drawing = false;
      const Probe = System.tick("Probe", function* () {
        const random = yield* Random;
        seen = Array.from(random.state);
        if (drawing) {
          random.bits();
        }
      });
      const hashAfterATick = Effect.fnUntraced(function* (draws: boolean) {
        drawing = draws;
        return yield* withApp(
          App.make(App.define({ systems: [Probe] }), { seed: 5 }),
          (app) =>
            Effect.gen(function* () {
              yield* app.tick(1);
              return (yield* app.read(World)).hash();
            })
        );
      });
      const still = yield* hashAfterATick(false);
      expect(seen).toEqual(Array.from(new Rng(5).state));
      expect(yield* hashAfterATick(false)).toBe(still);
      // A draw moves the generator, and the world with it.
      expect(yield* hashAfterATick(true)).not.toBe(still);
      expect(Random.key).toBe("arcadekit/Services.Random");
    })
  );

  it.effect("makes two apps with one seed agree, and two seeds differ", () =>
    Effect.gen(function* () {
      const first = yield* play(2024, 120);
      const second = yield* play(2024, 120);
      expect(second).toEqual(first);
      // The game really is random: it rolled, spawned and moved things.
      expect(first.sparks.length).toBeGreaterThan(0);
      expect(first.dice[0]![1]).toBeGreaterThan(20);
      // The gambler's rolls are the simulation's own, so only the moves made
      // from outside are in the log.
      expect(first.log.length).toBeGreaterThan(15);

      const other = yield* play(2025, 120);
      expect(other.hash).not.toBe(first.hash);
      expect(other.sparks).not.toEqual(first.sparks);
      expect(other.log).not.toEqual(first.log);
      // Leaving the seed out is seed 0, not a different game each time.
      expect(yield* play(undefined, 60)).toEqual(yield* play(0, 60));
      expect(yield* play(undefined, 60)).toEqual(yield* play(undefined, 60));
    })
  );

  it.effect("lets a game that uses it replay identically from its log", () =>
    Effect.gen(function* () {
      // The rolls are in the log as actions, so the replay runs the systems
      // and the handler, and must still draw the same numbers in the same order
      // to end in the same state.
      const Game = App.define({
        plugins: [Begin],
        systems: [Sparks],
        handlers: [roll],
      });
      const record = Effect.fnUntraced(function* (seed: number) {
        return yield* withApp(App.make(Game, { seed }), (app) =>
          Effect.gen(function* () {
            const other = new Rng(seed + 1000);
            for (let i = 0; i < 150; i++) {
              if (other.int(1, 4) === 1) {
                yield* app.dispatch(Roll, { sides: other.pick([4, 6, 8, 12]) });
              }
              yield* app.tick(1 / 60);
            }
            return yield* snapshot(app);
          })
        );
      });
      const replayOf = (recording: Replay.Recording) => {
        // Through bytes and back, as a save file would be.
        const loaded = Replay.decode(unwrap(Replay.encode(recording)));
        if (Exit.isFailure(loaded)) {
          throw new Error("the log did not survive being written down");
        }
        return Replay.verify(loaded.value, Game);
      };

      const recorded = yield* record(31);
      const { recording } = recorded;
      expect(recorded.dice[0]![1]).toBeGreaterThan(10);
      expect(recorded.sparks.length).toBeGreaterThan(0);
      expect(yield* withApp(replayOf(recording), snapshot)).toEqual(recorded);
      // With another seed the same moves would be a different game, and the
      // replay says so before its first tick.
      assert(recording.seed === 31);
      const diverged = yield* withApp(
        Effect.flip(replayOf({ ...recording, seed: 32 })),
        (error) => Effect.sync(() => error)
      );
      expect(diverged).toBeInstanceOf(Replay.Diverged);
      expect(diverged.message).toMatch(
        /the world's hash at tick 0 .* check the seed/
      );
    })
  );

  it.effect("refuses a bad seed when the app is made", () =>
    Effect.gen(function* () {
      expect(
        yield* thrown(
          withApp(App.make(App.define({}), { seed: 1.5 }), () =>
            Effect.succeed(0)
          )
        )
      ).toThrow(/random seed must be a whole number/);
    })
  );

  it.effect("seeds Effect's own Random inside the app too", () =>
    Effect.gen(function* () {
      const run = Effect.fnUntraced(function* (seed: number) {
        const out: number[] = [];
        let drew: number[] = [];
        const Draw = System.tick("Draw", function* () {
          out.push(yield* EffectRandom.next);
          out.push(yield* EffectRandom.nextInt);
          out.push(yield* EffectRandom.nextIntBetween(1, 6));
          out.push(...(yield* EffectRandom.shuffle([1, 2, 3, 4, 5])));
          const random = yield* Random;
          drew = Array.from(random.state);
          // The two are one generator: this continues the same sequence.
          out.push(random.bits());
        });
        return yield* withApp(
          App.make(App.define({ systems: [Draw] }), { seed }),
          (app) =>
            Effect.gen(function* () {
              const before = Array.from(new Rng(seed).state);
              yield* app.tick(1);
              // Effect's draws were from the world's generator, not from one of
              // their own: it had moved before anything drew from it by name.
              expect(drew).not.toEqual(before);
              return out;
            })
        );
      });
      const first = yield* run(8);
      expect(yield* run(8)).toEqual(first);
      expect(yield* run(9)).not.toEqual(first);
      expect(first[0]! >= 0 && first[0]! < 1).toBe(true);
      expect(Number.isSafeInteger(first[1])).toBe(true);
      expect(first[2]! >= 1 && first[2]! <= 6).toBe(true);

      // Its floats use all 53 bits and its integers both signs.
      const floats: number[] = [];
      const ints: number[] = [];
      const Many = System.tick("Many", function* () {
        for (let i = 0; i < 2000; i++) {
          floats.push(yield* EffectRandom.next);
          ints.push(yield* EffectRandom.nextInt);
        }
      });
      yield* withApp(
        App.make(App.define({ systems: [Many] }), { seed: 3 }),
        (app) =>
          Effect.gen(function* () {
            yield* app.tick(1);
            expect(floats.every((value) => value >= 0 && value < 1)).toBe(true);
            expect(floats.some((value) => (value * 2 ** 32) % 1 !== 0)).toBe(
              true
            );
            const mean = floats.reduce((sum, value) => sum + value, 0) / 2000;
            expect(mean).toBeGreaterThan(0.47);
            expect(mean).toBeLessThan(0.53);
            expect(ints.every((value) => Number.isSafeInteger(value))).toBe(
              true
            );
            expect(ints.some((value) => value < 0)).toBe(true);
            expect(ints.some((value) => value > 2 ** 40)).toBe(true);
            expect(ints.some((value) => value < -(2 ** 40))).toBe(true);
            expect(ints.some((value) => Math.abs(value) < 2 ** 50)).toBe(true);
          })
      );
    })
  );
});
