import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { entityIndex, entityOf } from "../src/ecs/component.ts";
import { CommandBuffer, World as EcsWorld } from "../src/ecs/index.ts";
import type { ComponentDef } from "../src/ecs/index.ts";
import {
  Action,
  App,
  Commands,
  Component,
  Event,
  Field,
  Query,
  Random,
  System,
  Timeline,
  World,
} from "../src/index.ts";
import type { Entity, JsonValue } from "../src/index.ts";

// One component of every field kind, in a table and in a sparse set.
const kinds = {
  single: Field.f32,
  double: Field.f64,
  signed: Field.i32,
  unsigned: Field.u32,
  short: Field.u16,
  byte: Field.u8,
  other: Field.entity,
  note: Field.json<JsonValue>(),
};
const Body = Component.define("hash/Body", { x: Field.f32, y: Field.f32 });
const Sheet = Component.define("hash/Sheet", kinds);
const Marked = Component.tag("hash/Marked");
const Aura = Component.define("hash/Aura", kinds, { storage: "sparse" });
const Chilled = Component.tag("hash/Chilled", { storage: "sparse" });

type SheetValue = Parameters<typeof Sheet.of>[0];

const sheet = (n: number): SheetValue => ({
  single: n + 0.5,
  double: n + 0.25,
  signed: -n,
  unsigned: 3_000_000_000 + n,
  short: 60_000 + n,
  byte: 200 + (n % 50),
  other: entityOf(n),
  note: `note ${n}`,
});

const scratch32 = new Float32Array(1);
const scratch32Bits = new Uint32Array(scratch32.buffer);
const scratch64 = new Float64Array(1);
const scratch64Bits = new BigUint64Array(scratch64.buffer);

/** The value a field would hold after the smallest change it can take. */
const nudged = (kind: string, value: unknown): unknown => {
  switch (kind) {
    case "f32": {
      scratch32[0] = value as number;
      scratch32Bits[0]! += 1;
      return scratch32[0];
    }
    case "f64": {
      scratch64[0] = value as number;
      scratch64Bits[0]! += 1n;
      return scratch64[0];
    }
    case "i32": {
      return (value as number) + 1;
    }
    case "u32":
    case "entity": {
      return (value as number) - 1;
    }
    case "u16":
    case "u8": {
      return (value as number) - 1;
    }
    default: {
      return `${String(value)}!`;
    }
  }
};

describe("the hash of a world", () => {
  it("is a whole number from 0 to 2^32 - 1, and does not change the world it reads", () => {
    const world = new EcsWorld({ seed: 4 });
    const check = (): number => {
      const hash = world.hash();
      expect(Number.isInteger(hash) && hash >= 0 && hash < 2 ** 32).toBe(true);
      expect(world.hash()).toBe(hash);
      return hash;
    };
    const empty = check();
    world.spawn(Body.of({ x: 1, y: 2 }), Aura.of(sheet(1)));
    expect(check()).not.toBe(empty);
    // It reads, so it is allowed where changes are not: inside a loop.
    let inside = -1;
    world.view(Query.all(Body)).each(() => {
      inside = world.hash();
    });
    expect(inside).toBe(world.hash());
    expect(new EcsWorld({ seed: 4 }).hash()).toBe(empty);
  });

  it("is worked out again from every column by the full hash, which sees a write the world was not told of", () => {
    const world = new EcsWorld();
    world.spawn(Body.of({ x: 1, y: 2 }));
    const before = world.hash();
    expect(world._fullHash()).toBe(before);
    world.view(Query.all(Body)).eachChunk((start, _end, body) => {
      // What a cast lets through: the query only reads Body.
      (body.x as unknown as Float32Array)[start] = 5;
    });
    expect(world.hash()).toBe(before);
    expect(world._fullHash()).not.toBe(before);
  });

  it("is the same number on every machine: the hash of this world is written down", () => {
    const world = new EcsWorld({ seed: 2026 });
    const a = world.spawn(
      Body.of({ x: 1.5, y: -2 }),
      Sheet.of(sheet(3)),
      Marked
    );
    const b = world.spawn(Body.of({ x: 0, y: 1e-3 }));
    world.add(a, Aura.of(sheet(9)));
    world.add(b, Chilled);
    world.despawn(world.spawn(Marked));
    world.random.next();
    // A different number here means every checkpoint in every recorded log
    // stops matching, so the change has to be meant.
    expect(world.hash()).toBe(KNOWN_HASH);
  });

  it("agrees between two worlds built by the same operations, at every step, and changes at every step", () => {
    for (const seed of [1, 2, 3, 4]) {
      const first = history(seed, 400);
      const second = history(seed, 400);
      expect(second).toEqual(first);
      // Every operation of the history changes something a simulation can
      // see, so no two neighbouring steps may share a hash.
      for (let i = 1; i < first.length; i++) {
        expect(first[i]).not.toBe(first[i - 1]);
      }
      // A step can undo the one before it, which brings an earlier hash
      // back, but most of 400 steps lead somewhere new.
      expect(new Set(first).size).toBeGreaterThan(300);
    }
    expect(history(1, 50)).not.toEqual(history(2, 50));
  });

  it("changes when any one field of any one component of any one entity changes", () => {
    // Tables of several sizes: the loop over a column takes four rows at a
    // time, and every position in a group, and the rows left over, must count.
    for (const size of [1, 2, 3, 4, 5, 6, 7, 8, 9, 33]) {
      const world = new EcsWorld();
      const entities: Entity[] = [];
      for (let n = 0; n < size; n++) {
        const entity = world.spawn(
          Body.of({ x: n, y: -n }),
          Sheet.of(sheet(n))
        );
        world.add(entity, Aura.of(sheet(n + 100)));
        entities.push(entity);
      }
      const base = world.hash();
      const seen = new Set([base]);
      let changes = 0;
      for (const entity of entities) {
        for (const def of [Body, Sheet, Aura] as ComponentDef[]) {
          const original = world.get(entity, def)!;
          for (let f = 0; f < def.fields.length; f++) {
            const field = def.fields[f]!;
            const kind = def.kinds[f]!;
            const values = [nudged(kind, original[field])];
            if (kind === "f32" || kind === "f64") {
              // The smallest change is in a float's lowest bit; the sign is
              // its highest, in the other half of a 64-bit one.
              values.push(
                -(original[field] as number),
                (original[field] as number) * 2 + 1024
              );
            }
            for (const value of values) {
              world.set(entity, def, { [field]: value });
              const changed = world.hash();
              expect(changed, `${def.name}.${field}`).not.toBe(base);
              seen.add(changed);
              changes++;
              world.set(entity, def, { [field]: original[field] });
              expect(world.hash(), `${def.name}.${field} restored`).toBe(base);
            }
          }
        }
      }
      // No two different changes gave the same hash either.
      expect(seen.size).toBe(changes + 1);
      // 2 + 8 + 8 fields, and two more changes for each of the 2 + 2 + 2 floats.
      expect(changes).toBe(size * (18 + 12));
    }
  });

  it("tells apart values that compare equal or print alike", () => {
    const hashOf = (note: JsonValue, single = 0, double = 0): number => {
      const world = new EcsWorld();
      world.spawn(Sheet.of({ ...sheet(1), note, single, double }));
      world.spawn(Aura.of({ ...sheet(2), note, single, double }));
      return world.hash();
    };
    const notes = [1, "1", true, 1n, null, undefined, "", 0, false, -1, 1.5];
    expect(new Set(notes.map((note) => hashOf(note))).size).toBe(notes.length);
    // 0 and -0 are different numbers to a simulation: 1 / x tells them apart.
    expect(hashOf("n", -0, 0)).not.toBe(hashOf("n", 0, 0));
    expect(hashOf("n", 0, -0)).not.toBe(hashOf("n", 0, 0));
    expect(hashOf(-0)).not.toBe(hashOf(0));
    expect(hashOf("ab")).not.toBe(hashOf("ba"));
    // An empty field is still a field: which of two rows is the empty one.
    const emptyAt = (row: number, storage: "table" | "sparse"): number => {
      const world = new EcsWorld();
      for (const index of [0, 1]) {
        const entity = world.spawn();
        const value = { ...sheet(0), note: index === row ? undefined : "x" };
        world.add(
          entity,
          storage === "table" ? Sheet.of(value) : Aura.of(value)
        );
      }
      return world.hash();
    };
    expect(emptyAt(0, "table")).not.toBe(emptyAt(1, "table"));
    expect(emptyAt(0, "sparse")).not.toBe(emptyAt(1, "sparse"));
    expect(hashOf(Number.NaN, Number.NaN, Number.NaN)).not.toBe(hashOf(0));
    expect(hashOf("n", Infinity)).not.toBe(hashOf("n", -Infinity));
  });

  it("counts every NaN as the same NaN, whatever bits an engine gave it", () => {
    const withNaNBits = (
      single: number,
      doubleHigh: number,
      doubleLow: number
    ): number => {
      const world = new EcsWorld();
      for (let n = 0; n < 6; n++) {
        world.add(world.spawn(Sheet.of(sheet(n))), Aura.of(sheet(n)));
      }
      const overwrite = (columns: {
        readonly single: Float32Array;
        readonly double: Float64Array;
      }): void => {
        const singles = new Uint32Array(columns.single.buffer);
        const doubles = new DataView(columns.double.buffer);
        for (const row of [0, 5]) {
          singles[row] = single;
          doubles.setUint32(row * 8, doubleLow, true);
          doubles.setUint32(row * 8 + 4, doubleHigh, true);
        }
      };
      world
        .view(Query.all(Sheet).pipe(Query.writes(Sheet)))
        .eachChunk((_start, _end, columns) => {
          overwrite(columns);
        });
      world
        .view(Query.all(Aura).pipe(Query.writes(Aura)))
        .eachChunk((_start, _end, aura) => {
          overwrite(aura.columns);
        });
      expect(
        world.get(world.view(Query.all(Sheet)).entities()[0]!, Sheet)
      ).toMatchObject({ single: Number.NaN, double: Number.NaN });
      return world.hash();
    };
    const quiet = withNaNBits(0x7fc00000, 0x7ff80000, 0);
    expect(withNaNBits(0xffc00000, 0xfff80000, 0)).toBe(quiet);
    expect(withNaNBits(0x7f800001, 0x7ff00000, 1)).toBe(quiet);
    expect(withNaNBits(0x7fffffff, 0x7fffffff, 0xffffffff)).toBe(quiet);
  });

  it("follows which entity and which field a value is in, not just the values", () => {
    const build = (
      first: readonly [number, number],
      second: readonly [number, number]
    ): number => {
      const world = new EcsWorld();
      const a = world.spawn(Body.of({ x: first[0], y: first[1] }));
      const b = world.spawn(Body.of({ x: second[0], y: second[1] }));
      world.add(a, Aura.of({ ...sheet(1), single: first[0] }));
      world.add(b, Aura.of({ ...sheet(1), single: second[0] }));
      return world.hash();
    };
    const base = build([1, 2], [3, 4]);
    expect(build([3, 4], [1, 2])).not.toBe(base); // swapped between entities
    expect(build([2, 1], [3, 4])).not.toBe(base); // swapped between fields
    expect(build([1, 4], [3, 2])).not.toBe(base);
    expect(build([1, 2], [3, 4])).toBe(base);

    // Which entity a sparse component is on, with the same values in it.
    const sparseOn = (index: number): number => {
      const world = new EcsWorld();
      const entities = [0, 1, 2].map(() => world.spawn(Body));
      world.add(entities[index]!, Aura.of(sheet(5)));
      world.add(entities[(index + 1) % 3]!, Chilled);
      return world.hash();
    };
    expect(new Set([sparseOn(0), sparseOn(1), sparseOn(2)]).size).toBe(3);
  });

  it("knows a component by its name and its fields, not by when it was defined", () => {
    const define = (
      names: readonly ("hash/order/A" | "hash/order/B" | "hash/order/C")[],
      second: Record<string, (typeof Field)["f32" | "i32"]>
    ) => {
      // Defined in the order given, so the ids differ from one call to the next.
      const defs = new Map<string, ComponentDef>();
      for (const name of names) {
        defs.set(
          name,
          name === "hash/order/A"
            ? Component.define(name, { v: Field.f32 })
            : Component.define(name, second)
        );
      }
      return defs;
    };
    const hashWith = (defs: Map<string, ComponentDef>): number => {
      const world = new EcsWorld();
      const a = defs.get("hash/order/A")!;
      const b = defs.get([...defs.keys()].find((name) => name !== a.name)!)!;
      world.spawn(
        a.of({ v: 1 }),
        b.of(Object.fromEntries(b.fields.map((f) => [f, 0])))
      );
      world.spawn(b);
      world.spawn(a.of({ v: 7 }));
      return world.hash();
    };
    const base = hashWith(
      define(["hash/order/A", "hash/order/B"], { p: Field.f32, q: Field.f32 })
    );
    // The same components, defined the other way round.
    expect(
      hashWith(
        define(["hash/order/B", "hash/order/A"], { p: Field.f32, q: Field.f32 })
      )
    ).toBe(base);
    // Another name, another field name, another field kind, fields swapped.
    expect(
      hashWith(
        define(["hash/order/A", "hash/order/C"], { p: Field.f32, q: Field.f32 })
      )
    ).not.toBe(base);
    expect(
      hashWith(
        define(["hash/order/A", "hash/order/B"], { p: Field.f32, r: Field.f32 })
      )
    ).not.toBe(base);
    expect(
      hashWith(
        define(["hash/order/A", "hash/order/B"], { p: Field.f32, q: Field.i32 })
      )
    ).not.toBe(base);
    expect(
      hashWith(
        define(["hash/order/A", "hash/order/B"], { q: Field.f32, p: Field.f32 })
      )
    ).not.toBe(base);
  });

  it("covers the order queries visit entities in", () => {
    // Both worlds hold the same two entities with the same data, the same
    // tables and the same ids to come. One entity made a round trip through
    // another table, which put it last in its own: which one differs.
    const build = (traveller: 0 | 1) => {
      const world = new EcsWorld();
      const pair = [
        world.spawn(Body.of({ x: 1, y: 1 })),
        world.spawn(Body.of({ x: 2, y: 2 })),
      ] as const;
      world.add(pair[traveller], Marked);
      world.remove(pair[traveller], Marked);
      return { world, order: world.view(Query.all(Body)).entities(), pair };
    };
    const first = build(0);
    const second = build(1);
    expect(first.order).toEqual([first.pair[1], first.pair[0]]);
    expect(second.order).toEqual([second.pair[0], second.pair[1]]);
    expect(first.world.hash()).not.toBe(second.world.hash());
    expect(build(0).world.hash()).toBe(first.world.hash());
  });

  it("covers a table that has emptied, because its place decides where later entities are visited", () => {
    const build = (visitMarkedFirst: boolean) => {
      const world = new EcsWorld();
      if (visitMarkedFirst) {
        // Creates the table of marked bodies before the table of bodies.
        const early = world.spawn(Body, Marked);
        world.remove(early, Marked);
      } else {
        const early = world.spawn(Body);
        world.add(early, Marked);
        world.remove(early, Marked);
      }
      return world;
    };
    const first = build(true);
    const second = build(false);
    // The same one entity with the same data in both...
    expect(first.view(Query.all(Body)).entities()).toEqual(
      second.view(Query.all(Body)).entities()
    );
    expect(first.hash()).not.toBe(second.hash());
    // ...and the difference is real: the next marked body is visited first
    // in one world and last in the other.
    const later = [first, second].map((world) => {
      const marked = world.spawn(Body, Marked);
      return world.view(Query.all(Body)).entities().indexOf(marked);
    });
    expect(later).toEqual([0, 1]);
  });

  it("covers the ids the next entities will get", () => {
    // Both end with no entities at all. They freed two slots in a different
    // order, so the next spawn gets a different id in each.
    const emptied = (reverse: boolean) => {
      const world = new EcsWorld();
      const a = world.spawn(Body);
      const b = world.spawn(Body);
      world.despawn(reverse ? b : a);
      world.despawn(reverse ? a : b);
      return world;
    };
    const first = emptied(false);
    const second = emptied(true);
    expect(first.entityCount).toBe(0);
    expect(first.hash()).not.toBe(second.hash());
    expect(first.spawn()).not.toBe(second.spawn());

    // The same slot freed once or twice: the next entity gets another generation.
    const reused = (times: number) => {
      const world = new EcsWorld();
      for (let i = 0; i < times; i++) {
        world.despawn(world.spawn(Body));
      }
      return world;
    };
    expect(reused(1).hash()).not.toBe(reused(2).hash());
    expect(reused(2).hash()).toBe(reused(2).hash());
    expect(reused(1).spawn()).not.toBe(reused(2).spawn());

    // A live entity's generation counts too: the same slot, the same data,
    // nothing freed, but one of the two is the slot's second tenant.
    const tenant = (reused: boolean) => {
      const world = new EcsWorld();
      if (reused) {
        const gone = world.spawn(Body);
        world.despawn(gone);
      }
      return { world, entity: world.spawn(Body.of({ x: 1, y: 1 })) };
    };
    const fresh = tenant(false);
    const later = tenant(true);
    expect(fresh.entity).not.toBe(later.entity);
    expect(fresh.world.view(Query.all(Body)).count()).toBe(1);
    expect(later.world.view(Query.all(Body)).count()).toBe(1);
    expect(fresh.world.hash()).not.toBe(later.world.hash());

    // An id reserved by a command that has not been applied yet.
    const pending = new EcsWorld();
    const before = pending.hash();
    const commands = new CommandBuffer(pending);
    commands.spawn(Body);
    const reserved = pending.hash();
    expect(reserved).not.toBe(before);
    commands.apply();
    expect(pending.hash()).not.toBe(reserved);
  });

  it("covers the random number generator", () => {
    const world = new EcsWorld({ seed: 10 });
    world.spawn(Body.of({ x: 1, y: 1 }));
    const before = world.hash();
    const state = Uint32Array.from(world.random.state);
    world.random.next();
    expect(world.hash()).not.toBe(before);
    world.random.state.set(state);
    expect(world.hash()).toBe(before);
    for (let word = 0; word < 4; word++) {
      world.random.state[word]! ^= 1;
      expect(world.hash()).not.toBe(before);
      world.random.state[word]! ^= 1;
    }
    const other = new EcsWorld({ seed: 11 });
    other.spawn(Body.of({ x: 1, y: 1 }));
    expect(other.hash()).not.toBe(before);
  });

  it("does not depend on what a simulation cannot tell apart", () => {
    const build = (noise: boolean): EcsWorld => {
      const world = new EcsWorld({ seed: 3 });
      const entities: Entity[] = [];
      for (let n = 0; n < 40; n++) {
        entities.push(world.spawn(Body.of({ x: n, y: n }), Sheet.of(sheet(n))));
      }
      if (noise) {
        // A query that meets the sparse components in another order first.
        world.view(Query.all(Body).pipe(Query.without(Chilled, Aura))).count();
      }
      // Members join the sparse sets in another order: the same members.
      const joining = noise ? entities.toReversed() : entities;
      for (const entity of joining) {
        if (entityIndex(entity) % 3 === 0) {
          world.add(entity, Aura.of(sheet(entityIndex(entity))));
        }
        if (entityIndex(entity) % 4 === 0) {
          world.add(entity, Chilled);
        }
      }
      if (noise) {
        // Queries: they cache tables, keep masks and create empty sparse sets.
        const Unused = Component.tag("hash/Unused", { storage: "sparse" });
        const view = world.view(
          Query.all(Body).pipe(Query.with(Aura), Query.without(Chilled, Unused))
        );
        view.each((body) => void body.x);
        view.eachChunk(() => {});
        view.count();
        world.view(Query.all(Aura).pipe(Query.with(Unused))).entities();
        // Reads, writes that put the same value back, and a registration.
        world.get(entities[0]!, Sheet);
        world.has(entities[1]!, Marked);
        world.set(entities[2]!, Body, { x: 99 });
        world.set(entities[2]!, Body, { x: 2 });
        world.register(Component.define("hash/Idle", { v: Field.f32 }));
        void new CommandBuffer(world).size;
        // A sparse component that came and went.
        world.add(entities[5]!, Unused);
        world.remove(entities[5]!, Unused);
      }
      return world;
    };
    expect(build(true).hash()).toBe(build(false).hash());
  });

  it("ignores what is left in a column past its last row", () => {
    // The last-spawned entity is despawned in both; its data stays behind in
    // the column's spare room, and differs between the two worlds.
    const build = (ghost: number): EcsWorld => {
      const world = new EcsWorld();
      world.spawn(Body.of({ x: 1, y: 1 }), Sheet.of(sheet(1)));
      const gone = world.spawn(
        Body.of({ x: ghost, y: ghost }),
        Sheet.of(sheet(ghost))
      );
      world.add(gone, Aura.of(sheet(ghost)));
      world.despawn(gone);
      return world;
    };
    expect(build(7).hash()).toBe(build(8).hash());
  });

  it("counts an array or an object in a json field by what is in it", () => {
    const hashOf = (note: JsonValue): number => {
      const world = new EcsWorld();
      world.spawn(Sheet.of({ ...sheet(1), note }));
      world.add(world.spawn(), Aura.of({ ...sheet(2), note }));
      return world.hash();
    };
    const values: JsonValue[] = [
      { hp: 1 },
      { hp: 2 },
      { hp: 1, mp: 0 },
      { hp: "1" },
      [1],
      [1, 2],
      [[1], 2],
      [],
      {},
      "[]",
      "{}",
      null,
      undefined,
      [null],
      { a: { b: [1, { c: true }] } },
      { a: { b: [1, { c: false }] } },
    ];
    expect(new Set(values.map((value) => hashOf(value))).size).toBe(
      values.length
    );
    // The same content is the same hash, whichever object holds it.
    expect(hashOf({ hp: 1, items: ["a", "b"] })).toBe(
      hashOf(structuredClone({ hp: 1, items: ["a", "b"] }))
    );
    // A value JSON cannot write is refused in so many words.
    expect(() =>
      // @ts-expect-error A bigint inside an object is not JSON.
      hashOf({ big: 1n })
    ).toThrow(/A json field holds a value that JSON cannot write/);
  });

  it("counts tags, which have no data, by who has them", () => {
    const build = (marked: number, chilled: number): number => {
      const world = new EcsWorld();
      const entities = [0, 1, 2].map(() => world.spawn(Body));
      world.add(entities[marked]!, Marked);
      world.add(entities[chilled]!, Chilled);
      return world.hash();
    };
    const all = [0, 1, 2].flatMap((marked) =>
      [0, 1, 2].map((chilled) => build(marked, chilled))
    );
    expect(new Set(all).size).toBe(9);
  });
});

/**
 * A world's hash after each of `steps` operations chosen by a seed. Every
 * operation changes something a simulation can see.
 */
const history = (seed: number, steps: number): number[] => {
  const world = new EcsWorld({ seed });
  // Its own generator decides what happens, so the world's is only drawn
  // from when the history says so.
  const dice = new EcsWorld({ seed: seed + 1 }).random;
  const commands = new CommandBuffer(world);
  const alive: Entity[] = [];
  const hashes: number[] = [];
  let serial = 0;
  const optional = [Body, Sheet, Marked, Aura, Chilled] as ComponentDef[];
  const valueFor = (def: ComponentDef) =>
    def === Body
      ? Body.of({ x: ++serial, y: dice.next() })
      : def === Sheet
        ? Sheet.of(sheet(++serial))
        : def === Aura
          ? Aura.of(sheet(++serial))
          : def;
  for (let step = 0; step < steps; step++) {
    const choice = alive.length === 0 ? 0 : dice.int(0, 7);
    const entity = alive.length === 0 ? undefined : dice.pick(alive);
    if (choice <= 1 || entity === undefined) {
      const inputs = optional
        .filter(() => dice.int(0, 1) === 1)
        .map((def) => valueFor(def));
      alive.push(
        choice === 0 ? world.spawn(...inputs) : commands.spawn(...inputs)
      );
      commands.apply();
    } else if (choice === 2) {
      world.despawn(entity);
      alive.splice(alive.indexOf(entity), 1);
    } else if (choice === 3 || choice === 4) {
      const def = dice.pick(optional);
      if (world.has(entity, def)) {
        world.remove(entity, def);
      } else {
        world.add(entity, valueFor(def));
      }
    } else if (choice === 5) {
      world.random.next();
    } else {
      const def = dice.pick([Body, Sheet, Aura] as ComponentDef[]);
      if (world.has(entity, def)) {
        const f = dice.int(0, def.fields.length - 1);
        const field = def.fields[f]!;
        world.set(entity, def, {
          [field]: nudged(def.kinds[f]!, world.get(entity, def)![field]),
        });
      } else {
        world.add(entity, valueFor(def));
      }
    }
    hashes.push(world.hash());
  }
  return hashes;
};

// It was 1,013,956,505 while an entity's id was 32 bits and hashed as one
// word, and 2,316,040,553 while all the columns were folded one after the
// other: each column is hashed on its own now, and folded in as one word.
const KNOWN_HASH = 522_063_573;

// --- through an app --------------------------------------------------------------

const withApp = <T extends Pick<App.Any, "read">, A, E2 = never>(
  make: Effect.Effect<T, never>,
  use: (app: T, world: Effect.Success<typeof World>) => Effect.Effect<A, E2>
) =>
  Effect.flatMap(make, (app) =>
    Effect.flatMap(app.read(World), (world) => use(app, world))
  );

const capture = Effect.fnUntraced(function* (app: Timeline.Game) {
  const moment = yield* Effect.exit(Timeline.capture(app));
  if (moment._tag !== "Success") {
    throw new Error("the game could not be captured");
  }
  return moment.value;
});

describe("the hash of an app's world", () => {
  const Drift = System.tick("Drift", function* () {
    const random = yield* Random;
    const commands = yield* Commands.spawns(Body);
    const bodies = yield* Query.all(Body).pipe(Query.writes(Body));
    bodies.each((body, entity) => {
      body.x += random.next();
      if (random.int(1, 20) === 1) {
        commands.despawn(entity);
      }
    });
    commands.spawn(Body.of({ x: 0, y: random.next() }));
  });
  const hashes = Effect.fnUntraced(function* (
    make: Effect.Effect<App.App, never>
  ) {
    return yield* withApp(make, (app, world) =>
      Effect.gen(function* () {
        const out: number[] = [];
        for (let i = 0; i < 100; i++) {
          yield* app.tick(1 / 60);
          out.push(world.hash());
        }
        return out;
      })
    );
  });

  it.effect(
    "agrees tick by tick between two apps given the same seed, which is how peers know they have not drifted",
    () =>
      Effect.gen(function* () {
        const first = yield* hashes(
          App.make(App.define({ systems: [Drift] }), { seed: 5 })
        );
        expect(
          yield* hashes(App.make(App.define({ systems: [Drift] }), { seed: 5 }))
        ).toEqual(first);
        expect(new Set(first).size).toBe(100);
        const other = yield* hashes(
          App.make(App.define({ systems: [Drift] }), { seed: 6 })
        );
        expect(other[0]).not.toBe(first[0]);
      })
  );

  it.effect(
    "shows the first tick at which one of them does something else",
    () =>
      Effect.gen(function* () {
        // The same game, but on tick 40 one machine rounds a number differently.
        let tick = 0;
        const Wrong = System.tick("Wrong", function* () {
          tick++;
          if (tick === 40) {
            let first = true;
            (yield* Query.all(Body).pipe(Query.writes(Body))).each((body) => {
              if (first) {
                body.y = nudged("f32", body.y) as number;
                first = false;
              }
            });
          }
        });
        const honest = yield* hashes(
          App.make(App.define({ systems: [Drift] }), { seed: 5 })
        );
        const faulty = yield* hashes(
          App.make(App.define({ systems: [Drift, Wrong] }), { seed: 5 })
        );
        const firstDifference = honest.findIndex(
          (hash, i) => hash !== faulty[i]
        );
        expect(firstDifference).toBe(39);
        expect(faulty.slice(0, 39)).toEqual(honest.slice(0, 39));
      })
  );

  it.effect("covers the game's time, which the world holds", () =>
    Effect.gen(function* () {
      const after = Effect.fnUntraced(function* (deltas: readonly number[]) {
        return yield* withApp(
          App.make(App.define({}), { seed: 5 }),
          (app, world) =>
            Effect.gen(function* () {
              for (const delta of deltas) {
                yield* app.tick(delta);
              }
              return world.hash();
            })
        );
      });
      const twice = yield* after([1 / 60, 1 / 60]);
      expect(yield* after([1 / 60, 1 / 60])).toBe(twice);
      // Nothing in the game moves, and only the time tells these apart.
      expect(yield* after([1 / 60])).not.toBe(twice);
      expect(yield* after([1 / 60, 1 / 30])).not.toBe(twice);
      expect(yield* after([1 / 30, 1 / 60])).not.toBe(twice);
    })
  );

  describe("covers what waits for the next tick", () => {
    const Rang = Event.define("hash/Rang", Schema.Struct({ n: Schema.Int }));
    const Push = Action.define("hash/Push", Schema.Struct({ by: Schema.Int }));
    const push = Action.handler(Push, function* () {});
    // A number the world doesn't keep: only the event tells it apart.
    let ringing: number | undefined;
    const Ring = System.tick("hash/Ring", function* () {
      if (ringing !== undefined) {
        (yield* Rang.emits).emit({ n: ringing });
      }
    });
    const Watch = System.frame("hash/Watch", function* () {
      (yield* Rang).read();
    });
    const make = () =>
      App.make(App.define({ systems: [Ring, Watch], handlers: [push] }), {
        seed: 5,
        checkpointEvery: 0,
      });
    const after = Effect.fnUntraced(function* (
      ring: number | undefined,
      act: (
        app: Effect.Success<ReturnType<typeof make>>
      ) => Effect.Effect<unknown, Action.InvalidPayload> = () => Effect.void
    ) {
      return yield* withApp(make(), (app, world) =>
        Effect.gen(function* () {
          ringing = ring;
          yield* app.tick(1 / 60);
          yield* act(app);
          return world.hash();
        })
      );
    });

    it.effect("the events the simulation has yet to read", () =>
      Effect.gen(function* () {
        const one = yield* after(1);
        expect(yield* after(1)).toBe(one);
        expect(yield* after(2)).not.toBe(one);
        expect(yield* after(undefined)).not.toBe(one);
      })
    );

    it.effect("the actions queued for the next tick, and who issued them", () =>
      Effect.gen(function* () {
        const idle = yield* after(undefined);
        const one = yield* after(undefined, (app) =>
          app.enqueue(Push, { by: 1 })
        );
        expect(one).not.toBe(idle);
        expect(
          yield* after(undefined, (app) => app.enqueue(Push, { by: 1 }))
        ).toBe(one);
        expect(
          yield* after(undefined, (app) => app.enqueue(Push, { by: 2 }))
        ).not.toBe(one);
        expect(
          yield* after(undefined, (app) =>
            app.enqueueByName("hash/Push", { by: 1 }, "ada")
          )
        ).not.toBe(one);
      })
    );

    it.effect(
      "but not where a reader between ticks is, so that watching changes nothing",
      () =>
        Effect.gen(function* () {
          expect(yield* after(1, (app) => app.frame())).toBe(yield* after(1));
        })
    );
  });

  it.effect(
    "is put back by a rewind with the actions queued and the events waiting, which every system then reads afresh",
    () =>
      Effect.gen(function* () {
        const Rang = Event.define(
          "hash/Rang2",
          Schema.Struct({ n: Schema.Int })
        );
        const Push = Action.define(
          "hash/Push2",
          Schema.Struct({ by: Schema.Int })
        );
        const heard: number[] = [];
        const pushed: number[] = [];
        const push = Action.handler(Push, function* ({ by }) {
          pushed.push(by);
        });
        let ringing = true;
        // Before the system that rings: it hears a ring on the tick after.
        const Hear = System.tick("hash/Hear", function* () {
          for (const { n } of (yield* Rang).read()) {
            heard.push(n);
          }
        });
        const Ring = System.tick("hash/Ring2", function* () {
          if (ringing) {
            (yield* Rang.emits).emit({ n: 1 });
          }
        });
        yield* withApp(
          App.make(App.define({ systems: [Hear, Ring], handlers: [push] }), {
            seed: 5,
          }),
          (app, world) =>
            Effect.gen(function* () {
              yield* app.tick(1 / 60);
              ringing = false;
              yield* app.enqueue(Push, { by: 7 });
              const hash = world.hash();
              const moment = yield* capture(app);
              yield* app.tick(1 / 60);
              expect([heard, pushed]).toEqual([[1], [7]]);
              yield* Timeline.rewind(app, moment);
              expect(world.hash()).toBe(hash);
              yield* app.tick(1 / 60);
              expect([heard, pushed]).toEqual([
                [1, 1],
                [7, 7],
              ]);
            })
        );
      })
  );

  it.effect("is put back with the game's time by a rewind", () =>
    withApp(
      App.make(App.define({ systems: [Drift] }), { seed: 5 }),
      (app, world) =>
        Effect.gen(function* () {
          yield* app.tick(1 / 60);
          yield* app.tick(1 / 30);
          const time = { ...app.time };
          const hash = world.hash();
          const moment = yield* capture(app);
          yield* app.tick(1 / 60);
          yield* Timeline.rewind(app, moment);
          expect(app.time).toEqual(time);
          expect(world.hash()).toBe(hash);
        })
    )
  );
});
