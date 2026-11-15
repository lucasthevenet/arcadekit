import { describe, expect, it } from "vitest";

import { Component, Field } from "../src/ecs/component";
import type { Entity } from "../src/ecs/component";
import { CommandBuffer, World } from "../src/ecs/world";
import type { QuerySpec, Terms } from "../src/ecs/world";

const Position = Component.define("st/Position", {
  x: Field.f32,
  y: Field.f32,
});
const Velocity = Component.define("st/Velocity", {
  x: Field.f32,
  y: Field.f32,
});
const Health = Component.define("st/Health", { hp: Field.i32 });
const Name = Component.define("st/Name", { value: Field.ref<string>() });
const Target = Component.define("st/Target", { entity: Field.entity });
const Enemy = Component.tag("st/Enemy");
const Stunned = Component.tag("st/Stunned", { storage: "sparse" });
const Burning = Component.define(
  "st/Burning",
  { seconds: Field.f32 },
  { storage: "sparse" }
);

const query = <const D extends Terms>(
  terms: D,
  withDefs: QuerySpec["withDefs"] = [],
  withoutDefs: QuerySpec["withoutDefs"] = []
): QuerySpec<D> => ({ terms, withDefs, withoutDefs });

describe("entities and components", () => {
  it("spawns, reads, writes and despawns", () => {
    const world = new World();
    const e = world.spawn(
      Position.of({ x: 1, y: 2 }),
      Health.of({ hp: 10 }),
      Enemy
    );
    expect(world.isAlive(e)).toBe(true);
    expect(world.entityCount).toBe(1);
    expect(world.get(e, Position)).toEqual({ x: 1, y: 2 });
    expect(world.has(e, Enemy)).toBe(true);
    expect(world.has(e, Velocity)).toBe(false);
    expect(world.get(e, Velocity)).toBeUndefined();

    world.set(e, Position, { y: 5 });
    expect(world.get(e, Position)).toEqual({ x: 1, y: 5 });

    expect(world.despawn(e)).toBe(true);
    expect(world.isAlive(e)).toBe(false);
    expect(world.get(e, Position)).toBeUndefined();
    expect(world.despawn(e)).toBe(false);
    expect(world.entityCount).toBe(0);
  });

  it("reuses a slot with a new generation, so stale handles stay dead", () => {
    const world = new World();
    const a = world.spawn(Health.of({ hp: 1 }));
    world.despawn(a);
    const b = world.spawn(Health.of({ hp: 2 }));
    expect(b).not.toBe(a);
    expect(world.isAlive(a)).toBe(false);
    expect(world.get(a, Health)).toBeUndefined();
    expect(world.get(b, Health)).toEqual({ hp: 2 });
  });

  it("zeroes a bare component and never leaks data from a removed row", () => {
    const world = new World();
    const a = world.spawn(Position.of({ x: 9, y: 9 }));
    world.despawn(a);
    const b = world.spawn(Position);
    expect(world.get(b, Position)).toEqual({ x: 0, y: 0 });
  });

  it("stores arbitrary values and entity references", () => {
    const world = new World();
    const a = world.spawn(Name.of({ value: "goblin" }));
    const b = world.spawn(
      Name.of({ value: "archer" }),
      Target.of({ entity: a })
    );
    expect(world.get(b, Name)).toEqual({ value: "archer" });
    const target = world.get(b, Target)!.entity;
    expect(target).toBe(a);
    expect(world.get(target, Name)).toEqual({ value: "goblin" });
  });

  it("keeps data when adding and removing components moves an entity between tables", () => {
    const world = new World();
    const a = world.spawn(Position.of({ x: 1, y: 1 }));
    const b = world.spawn(Position.of({ x: 2, y: 2 }));
    const c = world.spawn(Position.of({ x: 3, y: 3 }));

    // Moving `a` out swaps `c` into its row; both must still read correctly.
    world.add(a, Velocity.of({ x: 7, y: 8 }));
    expect(world.get(a, Position)).toEqual({ x: 1, y: 1 });
    expect(world.get(a, Velocity)).toEqual({ x: 7, y: 8 });
    expect(world.get(b, Position)).toEqual({ x: 2, y: 2 });
    expect(world.get(c, Position)).toEqual({ x: 3, y: 3 });

    world.remove(a, Position);
    expect(world.has(a, Position)).toBe(false);
    expect(world.get(a, Velocity)).toEqual({ x: 7, y: 8 });

    // Adding a component the entity already has overwrites in place.
    world.add(a, Velocity.of({ x: 0, y: 1 }));
    expect(world.get(a, Velocity)).toEqual({ x: 0, y: 1 });
    expect(world.remove(a, Health)).toBe(false);
  });

  it("rejects duplicate component names", () => {
    expect(() => Component.define("st/Position", { x: Field.f32 })).toThrow(
      /already defined/
    );
  });
});

describe("queries", () => {
  it("iterates every matching table with accessors and writes through them", () => {
    const world = new World();
    const a = world.spawn(
      Position.of({ x: 0, y: 0 }),
      Velocity.of({ x: 1, y: 2 })
    );
    const b = world.spawn(
      Position.of({ x: 10, y: 10 }),
      Velocity.of({ x: -1, y: 0 }),
      Enemy
    );
    const still = world.spawn(Position.of({ x: 5, y: 5 }));

    const moving = world.view(query([Position, Velocity]));
    const seen: Entity[] = [];
    moving.each((pos, vel, entity) => {
      pos.x += vel.x;
      pos.y += vel.y;
      seen.push(entity);
    });
    expect(seen.sort()).toEqual([a, b].sort());
    expect(world.get(a, Position)).toEqual({ x: 1, y: 2 });
    expect(world.get(b, Position)).toEqual({ x: 9, y: 10 });
    expect(world.get(still, Position)).toEqual({ x: 5, y: 5 });
    expect(moving.count()).toBe(2);
  });

  it("gives raw columns, one chunk per table when nothing is filtered per entity", () => {
    const world = new World();
    for (let i = 0; i < 100; i++) {
      world.spawn(Position.of({ x: i, y: 0 }), Velocity.of({ x: 1, y: 0 }));
    }
    for (let i = 0; i < 50; i++) {
      world.spawn(
        Position.of({ x: 0, y: 0 }),
        Velocity.of({ x: 1, y: 0 }),
        Enemy
      );
    }
    const moving = world.view(query([Position, Velocity]));
    const chunks: [number, number][] = [];
    moving.eachChunk((start, end, pos, vel, entities) => {
      expect(entities.length).toBeGreaterThanOrEqual(end);
      for (let i = start; i < end; i++) {
        pos.x[i]! += vel.x[i]!;
      }
      chunks.push([start, end]);
    });
    expect(chunks).toEqual([
      [0, 100],
      [0, 50],
    ]);
    let sum = 0;
    moving.each((pos) => {
      sum += pos.x;
    });
    expect(sum).toBe(4950 + 150);
  });

  it("picks up tables created after the view was first used", () => {
    const world = new World();
    const view = world.view(query([Position]));
    expect(view.count()).toBe(0);
    world.spawn(Position.of({ x: 1, y: 1 }));
    world.spawn(Position.of({ x: 1, y: 1 }), Health.of({ hp: 1 }));
    world.spawn(Health.of({ hp: 1 }));
    expect(view.count()).toBe(2);
    expect(world.view(view.spec)).toBe(view);
  });

  it("filters by table and sparse components", () => {
    const world = new World();
    const plain = world.spawn(Position.of({ x: 0, y: 0 }));
    const enemy = world.spawn(Position.of({ x: 0, y: 0 }), Enemy);
    const stunned = world.spawn(Position.of({ x: 0, y: 0 }), Enemy, Stunned);

    expect(
      world
        .view(query([Position], [Enemy]))
        .entities()
        .sort()
    ).toEqual([enemy, stunned].sort());
    expect(world.view(query([Position], [], [Enemy])).entities()).toEqual([
      plain,
    ]);
    expect(
      world.view(query([Position], [Enemy], [Stunned])).entities()
    ).toEqual([enemy]);
    expect(world.view(query([Position], [Stunned])).entities()).toEqual([
      stunned,
    ]);
  });

  it("does not move entities or create tables for sparse components", () => {
    const world = new World();
    const e = world.spawn(Position.of({ x: 1, y: 2 }));
    const tables = world.tables.length;
    world.add(e, Stunned);
    world.add(e, Burning.of({ seconds: 3 }));
    expect(world.tables).toHaveLength(tables);
    expect(world.has(e, Stunned)).toBe(true);
    expect(world.get(e, Burning)).toEqual({ seconds: 3 });
    world.set(e, Burning, { seconds: 1 });
    expect(world.get(e, Burning)).toEqual({ seconds: 1 });
    world.remove(e, Stunned);
    expect(world.has(e, Stunned)).toBe(false);
    expect(world.tables).toHaveLength(tables);
    world.despawn(e);
    const again = world.spawn(Position);
    expect(world.has(again, Burning)).toBe(false);
  });

  it("splits raw iteration into runs around rows a sparse filter excludes", () => {
    const world = new World();
    const all: Entity[] = [];
    for (let i = 0; i < 10; i++) {
      all.push(world.spawn(Position.of({ x: i, y: 0 })));
    }
    world.add(all[3]!, Stunned);
    world.add(all[7]!, Stunned);
    const awake = world.view(query([Position], [], [Stunned]));
    const chunks: [number, number][] = [];
    awake.eachChunk((start, end, pos) => {
      chunks.push([start, end]);
      for (let i = start; i < end; i++) {
        pos.x[i]! += 100;
      }
    });
    expect(chunks).toEqual([
      [0, 3],
      [4, 7],
      [8, 10],
    ]);
    expect(all.map((e) => world.get(e, Position)!.x)).toEqual([
      100, 101, 102, 3, 104, 105, 106, 7, 108, 109,
    ]);

    // Edges: excluded rows at both ends, and everything excluded.
    world.add(all[0]!, Stunned);
    world.add(all[9]!, Stunned);
    chunks.length = 0;
    awake.eachChunk((start, end) => void chunks.push([start, end]));
    expect(chunks).toEqual([
      [1, 3],
      [4, 7],
      [8, 9],
    ]);
    for (const e of all) {
      world.add(e, Stunned);
    }
    chunks.length = 0;
    awake.eachChunk((start, end) => void chunks.push([start, end]));
    expect(chunks).toEqual([]);
  });

  it("reads and writes sparse components as query data through accessors", () => {
    const world = new World();
    const a = world.spawn(
      Position.of({ x: 1, y: 0 }),
      Burning.of({ seconds: 5 })
    );
    const b = world.spawn(Position.of({ x: 2, y: 0 }));
    const c = world.spawn(
      Position.of({ x: 3, y: 0 }),
      Enemy,
      Burning.of({ seconds: 9 })
    );
    const burning = world.view(query([Position, Burning]));
    const seen: string[] = [];
    burning.each((pos, burn, entity) => {
      seen.push(`${entity}:${pos.x}:${burn.seconds}`);
      burn.seconds -= pos.x;
    });
    expect(seen.sort()).toEqual([`${a}:1:5`, `${c}:3:9`].sort());
    expect(world.get(a, Burning)).toEqual({ seconds: 4 });
    expect(world.get(c, Burning)).toEqual({ seconds: 6 });
    expect(world.has(b, Burning)).toBe(false);
    expect(burning.count()).toBe(2);
  });

  it("hands sparse data terms to raw loops as columns plus a row lookup", () => {
    const world = new World();
    const ents: Entity[] = [];
    for (let i = 0; i < 20; i++) {
      ents.push(world.spawn(Position.of({ x: i, y: 0 })));
    }
    for (const i of [11, 3, 2, 4]) {
      world.add(ents[i]!, Burning.of({ seconds: 1 }));
    }
    const view = world.view(query([Position, Burning]));
    for (const path of ["mask", "sorted"] as const) {
      view._path = path;
      const chunks: [number, number][] = [];
      view.eachChunk((start, end, pos, burning, entities) => {
        chunks.push([start, end]);
        const { seconds } = burning.columns;
        for (let i = start; i < end; i++) {
          seconds[burning.indexOf(entities[i]!)]! += pos.x[i]!;
        }
      });
      // Neighbouring rows are merged into one chunk whichever strategy found them.
      expect(chunks).toEqual([
        [2, 5],
        [11, 12],
      ]);
      expect(view._lastPath).toBe(path);
    }
    expect(
      [2, 3, 4, 11].map((i) => world.get(ents[i]!, Burning)!.seconds)
    ).toEqual([5, 7, 9, 23]);
  });

  it("visits entities in the same order whichever strategy finds them", () => {
    const world = new World();
    const ents: Entity[] = [];
    for (let i = 0; i < 4000; i++) {
      ents.push(
        i % 2 === 0
          ? world.spawn(Position.of({ x: i, y: 0 }))
          : world.spawn(Position.of({ x: i, y: 0 }), Enemy)
      );
    }
    // Added in an order that is not table order.
    for (const i of [900, 17, 500, 3]) {
      world.add(ents[i]!, Burning.of({ seconds: i }));
    }
    const view = world.view(query([Position], [Burning]));
    const order = (path: "auto" | "mask" | "sorted") => {
      view._path = path;
      const out: number[] = [];
      view.each((pos) => void out.push(pos.x));
      return out;
    };
    const tableOrder = [500, 900, 3, 17];
    expect(order("mask")).toEqual(tableOrder);
    expect(order("sorted")).toEqual(tableOrder);
    expect(view.entities().map((e) => world.get(e, Position)!.x)).toEqual(
      tableOrder
    );

    // Rare component: sort its few members. Common component: scan a mask.
    expect(order("auto")).toEqual(tableOrder);
    expect(view._lastPath).toBe("sorted");
    for (let i = 0; i < 1000; i++) {
      world.add(ents[i]!, Burning);
    }
    const common = order("auto");
    expect(view._lastPath).toBe("mask");
    expect(order("sorted")).toEqual(common);
    // The four early members are among the first thousand, so 1,000 in total.
    expect(common).toHaveLength(1000);
  });

  it("finds exact chunks when exclusions are rare enough for the native scan", () => {
    const world = new World();
    const ents: Entity[] = [];
    for (let i = 0; i < 3000; i++) {
      ents.push(world.spawn(Position.of({ x: i, y: 0 })));
    }
    const awake = world.view(query([Position], [], [Stunned]));
    const chunks = () => {
      const out: [number, number][] = [];
      awake.eachChunk((start, end) => void out.push([start, end]));
      return out;
    };
    expect(chunks()).toEqual([[0, 3000]]);
    for (const i of [0, 1000, 1001, 2999]) {
      world.add(ents[i]!, Stunned);
    }
    expect(chunks()).toEqual([
      [1, 1000],
      [1002, 2999],
    ]);
    const seen: number[] = [];
    awake.each((pos) => void seen.push(pos.x));
    expect(seen).toHaveLength(2996);
    expect(seen).not.toContain(1000);
    expect(seen[999]).toBe(1002);
  });

  it("never merges rows from different tables into one chunk", () => {
    const world = new World();
    const plain: Entity[] = [];
    const enemies: Entity[] = [];
    for (let i = 0; i < 200; i++) {
      plain.push(world.spawn(Position.of({ x: i, y: 0 })));
      enemies.push(world.spawn(Position.of({ x: 1000 + i, y: 0 }), Enemy));
    }
    // Row 2 of the first table and row 3 of the second sort next to each other.
    world.add(plain[2]!, Burning);
    world.add(enemies[3]!, Burning);
    const view = world.view(query([Position], [Burning]));
    for (const path of ["sorted", "mask"] as const) {
      view._path = path;
      const seen: Array<number>[] = [];
      view.eachChunk((start, end, pos) => {
        const xs: number[] = [];
        for (let i = start; i < end; i++) {
          xs.push(pos.x[i]!);
        }
        seen.push(xs);
      });
      expect(seen).toEqual([[2], [1003]]);
    }
  });

  it("supports nested iteration over the same view", () => {
    const world = new World();
    const ents: Entity[] = [];
    for (let i = 1; i <= 6; i++) {
      ents.push(world.spawn(Position.of({ x: i, y: 0 })));
    }
    world.add(ents[1]!, Stunned);
    world.add(ents[4]!, Stunned);
    for (const view of [
      world.view(query([Position])),
      world.view(query([Position], [], [Stunned])),
    ]) {
      const xs: number[] = [];
      view.each((pos) => void xs.push(pos.x));
      // Every ordered pair: the outer accessor must survive the inner loop.
      const pairs: string[] = [];
      view.each((a) => {
        view.each((b) => {
          pairs.push(`${a.x}-${b.x}`);
        });
        pairs.push(`after:${a.x}`);
      });
      const expected: string[] = [];
      for (const a of xs) {
        for (const b of xs) {
          expected.push(`${a}-${b}`);
        }
        expected.push(`after:${a}`);
      }
      expect(pairs).toEqual(expected);
    }
  });

  it("leaves no trace in its masks after a callback throws or a loop nests", () => {
    const world = new World();
    const ents: Entity[] = [];
    for (let i = 0; i < 50; i++) {
      ents.push(world.spawn(Position.of({ x: i, y: 0 })));
    }
    for (const i of [5, 6, 30]) {
      world.add(ents[i]!, Stunned);
    }
    const awake = world.view(query([Position], [], [Stunned]));
    const stunned = world.view(query([Position], [Stunned]));
    stunned._path = "mask";
    const snapshot = () =>
      [awake, stunned].map((view) => {
        const out: number[] = [];
        view.each((pos) => void out.push(pos.x));
        return out;
      });
    const before = snapshot();
    expect(before[0]).toHaveLength(47);
    expect(before[1]).toEqual([5, 6, 30]);

    for (const view of [awake, stunned]) {
      expect(() =>
        view.each(() => {
          view.eachChunk(() => {
            throw new Error("boom");
          });
        })
      ).toThrow("boom");
    }
    expect(snapshot()).toEqual(before);

    // The world moved on: the masks must reflect it, not the previous pass.
    world.remove(ents[5]!, Stunned);
    world.add(ents[40]!, Stunned);
    world.despawn(ents[0]!);
    const after = snapshot();
    expect([...after[1]!].sort((a, b) => a - b)).toEqual([6, 30, 40]);
    expect(after[0]).toHaveLength(46);
    expect(after[0]).not.toContain(40);
    expect(after[0]).toContain(5);
    expect(world.isAlive(ents[0]!)).toBe(false);
  });
});

describe("structural changes during iteration", () => {
  it("throws on direct changes and defers them through a command buffer", () => {
    const world = new World();
    const commands = new CommandBuffer(world);
    for (let i = 0; i < 10; i++) {
      world.spawn(Health.of({ hp: i }));
    }
    const view = world.view(query([Health]));

    expect(() => view.each((_, entity) => world.despawn(entity))).toThrow(
      /CommandBuffer/
    );
    // The guard must be released even though the loop threw.
    expect(() => world.spawn(Health.of({ hp: 1 }))).not.toThrow();
    expect(view.count()).toBe(11);

    let spawned: Entity | undefined;
    view.each((health, entity) => {
      if (health.hp < 5) {
        commands.despawn(entity);
      }
      if (health.hp === 9) {
        spawned = commands.spawn(Health.of({ hp: 100 }), Enemy);
      }
    });
    expect(view.count()).toBe(11);
    expect(world.isAlive(spawned!)).toBe(true);
    expect(world.has(spawned!, Health)).toBe(false);

    expect(commands.apply()).toBe(7);
    expect(commands.size).toBe(0);
    expect(view.count()).toBe(6);
    expect(world.get(spawned!, Health)).toEqual({ hp: 100 });
    expect(world.has(spawned!, Enemy)).toBe(true);
  });

  it("applies commands in order, ignoring ones aimed at dead entities", () => {
    const world = new World();
    const commands = new CommandBuffer(world);
    const e = commands.spawn(Position.of({ x: 1, y: 1 }));
    commands.add(e, Velocity.of({ x: 2, y: 2 }));
    commands.add(e, Stunned);
    commands.remove(e, Position);
    const doomed = commands.spawn(Health.of({ hp: 1 }));
    commands.despawn(doomed);
    commands.add(doomed, Enemy);
    commands.apply();
    expect(world.has(e, Position)).toBe(false);
    expect(world.get(e, Velocity)).toEqual({ x: 2, y: 2 });
    expect(world.has(e, Stunned)).toBe(true);
    expect(world.isAlive(doomed)).toBe(false);
    expect(world.entityCount).toBe(1);
  });
});

describe("randomized comparison against a simple model", () => {
  // A second, obviously-correct implementation: a Map of entity -> components.
  // Thousands of random operations must leave both in the same state.
  const defs = [Position, Velocity, Health, Enemy, Stunned, Burning] as const;
  const random = (seed: number) => () => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return seed / 0x1_00_00_00_00;
  };
  const sample = (def: (typeof defs)[number], rnd: () => number): any => {
    if (def === Position || def === Velocity) {
      return { x: Math.fround(rnd() * 100), y: Math.fround(rnd() * 100) };
    }
    if (def === Health) {
      return { hp: Math.floor(rnd() * 1000) };
    }
    if (def === Burning) {
      return { seconds: Math.fround(rnd() * 10) };
    }
    return {};
  };

  for (const seed of [1, 2, 3, 4, 5]) {
    it(`seed ${seed}`, () => {
      const rnd = random(seed);
      const world = new World();
      const model = new Map<Entity, Map<number, any>>();
      const dead: Entity[] = [];

      for (let step = 0; step < 4000; step++) {
        const roll = rnd();
        const live = [...model.keys()];
        const pick =
          live.length > 0 ? live[Math.floor(rnd() * live.length)] : undefined;
        const def = defs[Math.floor(rnd() * defs.length)]!;
        if (roll < 0.3 || pick === undefined) {
          const chosen = defs.filter(() => rnd() < 0.4);
          const values = new Map<number, any>();
          const inputs = chosen.map((d) => {
            const value = sample(d, rnd);
            values.set(d.id, value);
            return (d as any).of(value);
          });
          model.set(world.spawn(...inputs), values);
        } else if (roll < 0.45) {
          expect(world.despawn(pick)).toBe(true);
          model.delete(pick);
          dead.push(pick);
        } else if (roll < 0.75) {
          const value = sample(def!, rnd);
          world.add(pick, (def as any).of(value));
          model.get(pick)!.set(def.id, value);
        } else {
          expect(world.remove(pick, def)).toBe(model.get(pick)!.delete(def.id));
        }
      }

      expect(world.entityCount).toBe(model.size);
      for (const entity of dead) {
        expect(world.isAlive(entity)).toBe(false);
      }
      for (const [entity, values] of model) {
        expect(world.isAlive(entity)).toBe(true);
        for (const def of defs) {
          expect(world.has(entity, def)).toBe(values.has(def.id));
          expect(world.get(entity, def as any)).toEqual(values.get(def.id));
        }
      }

      // Every query must agree with a brute-force filter of the model.
      for (const required of defs) {
        if (required.storage !== "table") {
          continue;
        }
        for (const excluded of defs) {
          if (excluded === required) {
            continue;
          }
          const expected = [...model]
            .filter(
              ([, values]) =>
                values.has(required.id) && !values.has(excluded.id)
            )
            .map(([entity]) => entity)
            .sort();
          const view = world.view(query([required], [], [excluded]));
          expect(view.entities().sort()).toEqual(expected);
          expect(view.count()).toBe(expected.length);
          const visited: Entity[] = [];
          view.each((_, entity) => {
            visited.push(entity);
          });
          expect(visited.sort()).toEqual(expected);
        }
      }

      // Sparse conditions and sparse data, under both iteration strategies
      // and through both the accessor and the raw-column API.
      for (const path of ["mask", "sorted"] as const) {
        for (const sparse of [Stunned, Burning]) {
          const expected = [...model]
            .filter(
              ([, values]) =>
                values.has(Position.id) &&
                values.has(sparse.id) &&
                !values.has(Enemy.id)
            )
            .map(([entity]) => entity)
            .sort();
          const view = world.view(query([Position], [sparse], [Enemy]));
          view._path = path;
          const visited: Entity[] = [];
          view.each((pos, entity) => {
            expect(pos.x).toBe(model.get(entity)!.get(Position.id).x);
            visited.push(entity);
          });
          expect(visited.sort()).toEqual(expected);
          const chunked: Entity[] = [];
          view.eachChunk((start, end, pos, entities) => {
            expect(end).toBeGreaterThan(start);
            for (let i = start; i < end; i++) {
              const entity = entities[i] as Entity;
              expect(pos.y[i]).toBe(model.get(entity)!.get(Position.id).y);
              chunked.push(entity);
            }
          });
          expect(chunked.sort()).toEqual(expected);
        }

        const expected = [...model]
          .filter(
            ([, values]) =>
              values.has(Health.id) &&
              values.has(Burning.id) &&
              !values.has(Stunned.id)
          )
          .map(([entity]) => entity)
          .sort();
        const view = world.view(query([Health, Burning], [], [Stunned]));
        view._path = path;
        const visited: Entity[] = [];
        view.each((health, burn, entity) => {
          expect(health.hp).toBe(model.get(entity)!.get(Health.id).hp);
          expect(burn.seconds).toBe(model.get(entity)!.get(Burning.id).seconds);
          visited.push(entity);
        });
        expect(visited.sort()).toEqual(expected);
        const chunked: Entity[] = [];
        view.eachChunk((start, end, health, burning, entities) => {
          for (let i = start; i < end; i++) {
            const entity = entities[i] as Entity;
            expect(health.hp[i]).toBe(model.get(entity)!.get(Health.id).hp);
            expect(burning.columns.seconds[burning.indexOf(entity)]).toBe(
              model.get(entity)!.get(Burning.id).seconds
            );
            chunked.push(entity);
          }
        });
        expect(chunked.sort()).toEqual(expected);
      }

      // A sparse `without` must split raw chunks without losing or adding rows.
      const awake = [...model]
        .filter(
          ([, values]) => values.has(Position.id) && !values.has(Stunned.id)
        )
        .map(([entity]) => entity)
        .sort();
      const chunked: Entity[] = [];
      world
        .view(query([Position], [], [Stunned]))
        .eachChunk((start, end, _pos, entities) => {
          for (let i = start; i < end; i++) {
            chunked.push(entities[i] as Entity);
          }
        });
      expect(chunked.sort()).toEqual(awake);
    });
  }
});
