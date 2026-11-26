import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { World as EcsWorld } from "../src/ecs/index.ts";
import {
  App,
  Commands,
  Component,
  EntityId,
  Field,
  Overlap,
  Plugin,
  Query,
  Singleton,
  System,
  Time,
  Transform2d,
  World,
} from "../src/index.ts";
import type { Entity } from "../src/index.ts";
import { Query as QueryClass } from "../src/Query.ts";

/** A seeded generator, so that a failure repeats. */
const generator = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

describe("two shapes", () => {
  it("touch when their edges meet, and not when apart", () => {
    expect(Overlap.circles(0, 0, 1, 2, 0, 1)).toBe(true);
    expect(Overlap.circles(0, 0, 1, 2.01, 0, 1)).toBe(false);
    expect(Overlap.boxes(0, 0, 1, 1, 2, 2, 1, 1)).toBe(true);
    expect(Overlap.boxes(0, 0, 1, 1, 2, 2.01, 1, 1)).toBe(false);
    // Beside a side, and off a corner.
    expect(Overlap.circleBox(0, 3, 1, 0, 0, 2, 2)).toBe(true);
    expect(Overlap.circleBox(2.8, 2.8, 1, 0, 0, 2, 2)).toBe(false);
    expect(Overlap.circleBox(2.7, 2.7, 1, 0, 0, 2, 2)).toBe(true);
    // A centre inside the box.
    expect(Overlap.circleBox(0.5, 0.5, 0.1, 0, 0, 2, 2)).toBe(true);
  });
});

// --- every pair, against a check of every pair by hand -----------------------

const Red = Component.tag("ov/Red");
const Blue = Component.tag("ov/Blue");

const shapesOf = (world: EcsWorld, entity: Entity) => {
  const at = world.get(entity, Transform2d.Position)!;
  const circle = world.get(entity, Overlap.Circle);
  const box = world.get(entity, Overlap.Box);
  return { x: at.x, y: at.y, circle, box };
};

/** Whether two shapes touch, worked out another way: by the nearest point. */
const byHand = (
  a: ReturnType<typeof shapesOf>,
  b: ReturnType<typeof shapesOf>
): boolean => {
  if (a.circle !== undefined && b.circle !== undefined) {
    return (
      Math.hypot(a.x - b.x, a.y - b.y) <= a.circle.radius + b.circle.radius
    );
  }
  if (a.box !== undefined && b.box !== undefined) {
    return (
      a.x - a.box.halfWidth <= b.x + b.box.halfWidth &&
      b.x - b.box.halfWidth <= a.x + a.box.halfWidth &&
      a.y - a.box.halfHeight <= b.y + b.box.halfHeight &&
      b.y - b.box.halfHeight <= a.y + a.box.halfHeight
    );
  }
  const [c, x] = a.circle === undefined ? [b, a] : [a, b];
  const nx = Math.min(
    Math.max(c.x, x.x - x.box!.halfWidth),
    x.x + x.box!.halfWidth
  );
  const ny = Math.min(
    Math.max(c.y, x.y - x.box!.halfHeight),
    x.y + x.box!.halfHeight
  );
  return Math.hypot(c.x - nx, c.y - ny) <= c.circle!.radius;
};

const NONE = { despawn: () => {} };

describe("the pairs of two queries", () => {
  it("are the pairs whose shapes touch, in order, for circles and boxes alike", () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const random = generator(seed);
      const world = new EcsWorld();
      for (let i = 0; i < 120; i++) {
        const round = random() < 0.5;
        world.spawn(
          random() < 0.5 ? Red : Blue,
          Transform2d.Position.of({
            x: Math.round(random() * 40),
            y: Math.round(random() * 40),
          }),
          round
            ? Overlap.Circle.of({ radius: 1 + Math.round(random() * 3) })
            : Overlap.Box.of({
                halfWidth: 1 + Math.round(random() * 3),
                halfHeight: 1 + Math.round(random() * 3),
              })
        );
      }
      for (const [first, second] of [
        [Overlap.Circle, Overlap.Circle],
        [Overlap.Circle, Overlap.Box],
        [Overlap.Box, Overlap.Circle],
        [Overlap.Box, Overlap.Box],
      ] as const) {
        const reds = world.view(
          Query.all(Transform2d.Position, first).pipe(Query.with(Red))
        );
        const blues = world.view(
          Query.all(Transform2d.Position, second).pipe(Query.with(Blue))
        );
        const found: [Entity, Entity][] = [];
        Overlap.pairs(NONE, reds, blues, (red, blue) => {
          found.push([red, blue]);
          return "neither";
        });
        const expected: [Entity, Entity][] = [];
        for (const red of reds.entities()) {
          for (const blue of blues.entities()) {
            if (byHand(shapesOf(world, red), shapesOf(world, blue))) {
              expected.push([red, blue]);
            }
          }
        }
        expect(found).toEqual(expected);
        expect(found.length, `seed ${seed}`).toBeGreaterThan(0);
      }
    }
  });

  it("leave out an entity paired with itself", () => {
    const world = new EcsWorld();
    for (let i = 0; i < 3; i++) {
      world.spawn(
        Transform2d.Position.of({ x: i, y: 0 }),
        Overlap.Circle.of({ radius: 1 })
      );
    }
    const all = world.view(Query.all(Transform2d.Position, Overlap.Circle));
    let count = 0;
    Overlap.pairs(NONE, all, all, () => {
      count++;
      return "neither";
    });
    // 0-1, 1-0, 1-2, 2-1 and 0-2, 2-0: the edges of 0 and 2 meet.
    expect(count).toBe(6);
  });

  it("refuse a change query, a shape an entity may lack, and a call from inside", () => {
    const world = new EcsWorld();
    for (const x of [0, 1]) {
      world.spawn(
        Transform2d.Position.of({ x, y: 0 }),
        Overlap.Circle.of({ radius: 1 })
      );
    }
    const all = world.view(Query.all(Transform2d.Position, Overlap.Circle));
    const moved = world.view(
      Query.all(Transform2d.Position, Overlap.Circle).pipe(
        Query.changed(Transform2d.Position)
      )
    );
    expect(() => Overlap.pairs(NONE, moved, all, () => "neither")).toThrow(
      "Overlap.pairs was given a change query"
    );
    const maybe = world.view(
      Query.all(Transform2d.Position, Query.maybe(Overlap.Circle))
    );
    expect(() => Overlap.pairs(NONE, maybe, all, () => "neither")).toThrow(
      `"arcadekit/Overlap.Circle" is a Query.maybe term`
    );
    // Past the compiler, the terms are checked as it runs.
    const loose = world.view(
      new QueryClass([Overlap.Circle, Transform2d.Position], [], [], [], [], [])
    );
    // @ts-expect-error the position comes first
    expect(() => Overlap.pairs(NONE, loose, all, () => "neither")).toThrow(
      `a query of "arcadekit/Overlap.Circle", "arcadekit/Transform2d.Position"`
    );
    expect(() =>
      Overlap.pairs(NONE, all, all, () => {
        Overlap.pairs(NONE, all, all, () => "neither");
        return "neither";
      })
    ).toThrow("Overlap.pairs was called from inside its own callback");
    // And the next call works, once the one that threw is over.
    expect(() => Overlap.pairs(NONE, all, all, () => "neither")).not.toThrow();
  });

  it("does not compile with a query that has no position or no shape", () => {
    const world = new EcsWorld();
    const bare = world.view(Query.all(Overlap.Circle));
    const unshaped = world.view(Query.all(Transform2d.Position));
    const all = world.view(Query.all(Transform2d.Position, Overlap.Box));
    // @ts-expect-error no position
    expect(() => Overlap.pairs(NONE, bare, all, () => "neither")).toThrow(
      `a query of "arcadekit/Overlap.Circle". It reads`
    );
    // @ts-expect-error no shape
    expect(() => Overlap.pairs(NONE, all, unshaped, () => "neither")).toThrow(
      `a query of "arcadekit/Transform2d.Position". It reads`
    );
    // @ts-expect-error a callback that doesn't say what to despawn
    Overlap.pairs(NONE, all, all, () => {});
  });
});

// --- a shooter: bullets fly at enemies, and a hit costs a point of health ---

const Bullet = Component.define("ov/Bullet", { dx: Field.f32 });
const Enemy = Component.define("ov/Enemy", { hp: Field.i32 });

const Tally = Singleton.define(
  "ov/Tally",
  { hits: Field.schema(Schema.Array(Schema.Tuple([EntityId, EntityId]))) },
  { hits: [] }
);

const Flying = Query.all(Transform2d.Position, Bullet).pipe(
  Query.writes(Transform2d.Position)
);
const Bullets = Query.all(Transform2d.Position, Overlap.Circle, Bullet);
const Enemies = Query.all(Transform2d.Position, Overlap.Circle, Enemy);

const Fly = System.tick("ov/Fly", function* () {
  const { delta } = yield* Time;
  (yield* Flying).each((position, bullet) => {
    position.x += bullet.dx * delta;
  });
});

const Hit = System.tick("ov/Hit", function* () {
  const world = yield* World.writes(Enemy);
  const commands = yield* Commands;
  const tally = yield* Tally.writes;
  Overlap.pairs(commands, yield* Bullets, yield* Enemies, (bullet, enemy) => {
    const hp = world.get(enemy, Enemy)!.hp - 1;
    world.set(enemy, Enemy, { hp });
    tally.hits = [...tally.hits, [bullet, enemy]];
    return hp > 0 ? "first" : "both";
  });
});

/** A spawn of enemies and bullets, as the test lays them out. */
const scene = (
  enemies: readonly { readonly x: number; readonly hp: number }[],
  bullets: readonly number[]
) =>
  Plugin.make("ov/Scene", {
    setup: Effect.gen(function* () {
      const commands = yield* Commands.spawns(
        Transform2d.Position,
        Overlap.Circle,
        Enemy,
        Bullet
      );
      for (const { x, hp } of enemies) {
        commands.spawn(
          Transform2d.Position.of({ x, y: 0 }),
          Overlap.Circle.of({ radius: 1 }),
          Enemy.of({ hp })
        );
      }
      for (const x of bullets) {
        commands.spawn(
          Transform2d.Position.of({ x, y: 0 }),
          Overlap.Circle.of({ radius: 0.25 }),
          Bullet.of({ dx: 10 })
        );
      }
    }),
  });

const shooter = (
  enemies: readonly { readonly x: number; readonly hp: number }[],
  bullets: readonly number[]
) =>
  App.make(
    App.define({
      plugins: [scene(enemies, bullets)],
      systems: [Fly, Hit],
    })
  );

describe("a shooter", () => {
  it.effect("spends a bullet on one enemy, and kills an enemy once", () =>
    Effect.gen(function* () {
      // Two bullets on an enemy with one point left, and one bullet on two
      // enemies that stand together.
      const app = yield* shooter(
        [
          { x: 0, hp: 1 },
          { x: 10, hp: 5 },
          { x: 10.5, hp: 5 },
        ],
        [0.1, -0.1, 10.2]
      );
      yield* app.tick(0);
      const world = yield* app.read(World);
      const enemies = (yield* app.read(Query.all(Enemy))).entities();
      const bullets = (yield* app.read(Query.all(Bullet))).entities();
      // The first bullet killed the first enemy, and the second bullet,
      // which no enemy is left to stop, flies on.
      const left = enemies.map((enemy) => [
        world.get(enemy, Transform2d.Position)!.x,
        world.get(enemy, Enemy)!.hp,
      ]);
      expect(left.toSorted(([a], [b]) => a! - b!)).toEqual([
        [10, 4],
        [10.5, 5],
      ]);
      expect(bullets).toHaveLength(1);
      expect((yield* app.read(Tally)).hits).toHaveLength(2);
    })
  );

  it.effect(
    "never spends a bullet twice or hits an enemy past its health, over many ticks",
    () =>
      Effect.gen(function* () {
        for (const seed of [11, 12, 13]) {
          const random = generator(seed);
          const enemies = Array.from({ length: 20 }, (_, i) => ({
            x: 20 + i * 1.5,
            hp: 1 + Math.floor(random() * 3),
          }));
          const bullets = Array.from({ length: 60 }, () => random() * 15);
          const app = yield* shooter(enemies, bullets);
          // Spawned in order, so each id has the health it was given.
          const health = new Map(
            (yield* app.read(Query.all(Enemy)))
              .entities()
              .map((enemy, i) => [enemy, enemies[i]!.hp] as const)
          );
          for (let i = 0; i < 180; i++) {
            yield* app.tick(1 / 60);
          }
          const { hits } = yield* app.read(Tally);
          expect(hits.length, `seed ${seed}`).toBeGreaterThan(20);
          const shots = hits.map(([bullet]) => bullet);
          expect(new Set(shots).size).toBe(shots.length);
          const taken = new Map<Entity, number>();
          for (const [, enemy] of hits) {
            taken.set(enemy, (taken.get(enemy) ?? 0) + 1);
          }
          const world = yield* app.read(World);
          for (const [enemy, hp] of health) {
            const count = taken.get(enemy) ?? 0;
            expect(count).toBeLessThanOrEqual(hp);
            // Gone exactly when its health ran out.
            expect(world.isAlive(enemy)).toBe(count < hp);
          }
          expect((yield* app.read(Query.all(Bullet))).count()).toBe(
            bullets.length - hits.length
          );
        }
      })
  );
});
