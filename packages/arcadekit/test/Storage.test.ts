import { describe, expect, expectTypeOf, it } from "vitest";

import { CommandBuffer } from "../src/ecs/commands.ts";
import {
  Component,
  Field,
  entityIndex,
  entityOf,
  idOf,
} from "../src/ecs/component.ts";
import type { ComponentDef, Entity, RequiredOf } from "../src/ecs/component.ts";
import type { QuerySpec, Terms } from "../src/ecs/query.ts";
import { World } from "../src/ecs/world.ts";
import { Query, all, maybe, without } from "../src/Query.ts";
import { expectChecked, makeChecks } from "./checks.ts";

const Position = Component.define("st/Position", {
  x: Field.f32,
  y: Field.f32,
});
const Velocity = Component.define("st/Velocity", {
  x: Field.f32,
  y: Field.f32,
});
const Health = Component.define("st/Health", { hp: Field.i32 });
const Name = Component.define("st/Name", { value: Field.json<string>() });
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
  withDefs: Terms = [],
  withoutDefs: Terms = [],
  more: { readonly changedDefs?: Terms; readonly readDefs?: Terms } = {}
): Query<D> =>
  new Query(
    terms,
    withDefs,
    withoutDefs,
    more.changedDefs,
    [],
    terms.filter((def) => more.readDefs?.includes(def) !== true)
  );

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

  it("gives a component added bare its initial value, where it says one, and zeros where it does not", () => {
    const Size = Component.define(
      "test/Size",
      { width: Field.f32, height: Field.f32 },
      { initial: { width: 1, height: 2 } }
    );
    const Glow = Component.define(
      "test/Glow",
      { level: Field.u8 },
      { storage: "sparse", initial: { level: 7 } }
    );
    const world = new World();
    // Spawned bare, in a table and in a sparse set.
    const spawned = world.spawn(Size, Glow, Position);
    expect(world.get(spawned, Size)).toEqual({ width: 1, height: 2 });
    expect(world.get(spawned, Glow)).toEqual({ level: 7 });
    expect(world.get(spawned, Position)).toEqual({ x: 0, y: 0 });
    // Added bare, as the entity moves to another table.
    const added = world.spawn(Health.of({ hp: 3 }));
    world.add(added, Size);
    world.add(added, Glow);
    expect(world.get(added, Size)).toEqual({ width: 1, height: 2 });
    expect(world.get(added, Glow)).toEqual({ level: 7 });
    // A value says what it is; added bare again, a component it has keeps
    // its value.
    const given = world.spawn(Size.of({ width: 5, height: 6 }));
    expect(world.get(given, Size)).toEqual({ width: 5, height: 6 });
    world.add(given, Size);
    expect(world.get(given, Size)).toEqual({ width: 5, height: 6 });
    // A slot that is used again holds nothing of the entity before it.
    world.despawn(spawned);
    const again = world.spawn(Size, Glow);
    expect(world.get(again, Size)).toEqual({ width: 1, height: 2 });
    expect(world.get(again, Glow)).toEqual({ level: 7 });
  });

  it("takes the later value of a component given twice, whatever was spawned before", () => {
    const world = new World();
    world.spawn(Position, Velocity, Health);
    world.spawn(Health, Stunned);
    const e = world.spawn(
      Velocity.of({ x: 1, y: 1 }),
      Stunned,
      Position.of({ x: 2, y: 2 }),
      Velocity.of({ x: 3, y: 3 }),
      Position.of({ x: 4, y: 4 })
    );
    expect(world.get(e, Velocity)).toEqual({ x: 3, y: 3 });
    expect(world.get(e, Position)).toEqual({ x: 4, y: 4 });
    expect(world.has(e, Stunned)).toBe(true);
    expect(world.has(e, Health)).toBe(false);
    expect(world.tables.map((t) => t.defs.map((d) => d.name))).toEqual([
      ["st/Position", "st/Velocity", "st/Health"],
      ["st/Health"],
      ["st/Position", "st/Velocity"],
    ]);
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

  it("takes a number left out of a value for 0, as in a component added with none, and never for NaN", () => {
    const Mixed = Component.define("st/Mixed", {
      x: Field.f32,
      wide: Field.f64,
      hp: Field.i32,
      who: Field.entity,
      name: Field.json<string | undefined>(),
      cache: Field.transient<object>(),
    });
    const Faint = Component.define(
      "st/Faint",
      { seconds: Field.f32, turns: Field.u8 },
      { storage: "sparse" }
    );
    const world = new World();
    // A row that held other numbers, so that nothing is 0 by luck.
    const old = world.spawn(
      Mixed.of({
        x: 9,
        wide: 9,
        hp: 9,
        who: entityOf(9),
        name: "old",
        cache: {},
      }),
      Faint.of({ seconds: 9, turns: 9 })
    );
    world.despawn(old);
    // Past the compiler, as JavaScript or a cast gets there.
    const spawned = world.spawn(
      Mixed.of({ x: 3 } as never),
      Faint.of({} as never)
    );
    expect(world.get(spawned, Mixed)).toEqual({
      x: 3,
      wide: 0,
      hp: 0,
      who: 0,
      // What is not a number is not there.
      name: undefined,
      cache: undefined,
    });
    expect(world.get(spawned, Faint)).toEqual({ seconds: 0, turns: 0 });
    // Named and not given is the same as not named.
    const named = world.spawn(
      Mixed.of({ x: undefined, wide: 2, hp: undefined } as never)
    );
    expect(world.get(named, Mixed)).toMatchObject({ x: 0, wide: 2, hp: 0 });
    // Added, to an entity without it and over the one it has: a value is
    // the whole component, and what it leaves out is 0 again.
    const added = world.spawn();
    world.add(added, Mixed.of({ wide: 4 } as never));
    expect(world.get(added, Mixed)).toMatchObject({ x: 0, wide: 4, hp: 0 });
    world.add(spawned, Mixed.of({ hp: 5 } as never));
    expect(world.get(spawned, Mixed)).toMatchObject({ x: 0, wide: 0, hp: 5 });
    world.add(spawned, Faint.of({ turns: 2 } as never));
    expect(world.get(spawned, Faint)).toEqual({ seconds: 0, turns: 2 });
    // Through a command buffer, which is how a system does either.
    const commands = new CommandBuffer(world);
    const later = commands.spawn(Mixed.of({ hp: 7 } as never));
    commands.add(added, Faint.of({} as never));
    commands.apply();
    expect(world.get(later, Mixed)).toMatchObject({ x: 0, wide: 0, hp: 7 });
    expect(world.get(added, Faint)).toEqual({ seconds: 0, turns: 0 });
    // A number that is given is written as it is, whatever it is.
    const odd = world.spawn(Mixed.of({ x: Number.NaN, wide: -0 } as never));
    expect(world.get(odd, Mixed)!.x).toBeNaN();
    expect(Object.is(world.get(odd, Mixed)!.wide, -0)).toBe(true);
  });

  it("leaves a number as it was when set names it and gives none, and writes what is not a number", () => {
    const Mixed = Component.define("st/Mixed2", {
      x: Field.f32,
      hp: Field.i32,
      name: Field.json<string | undefined>(),
    });
    const Faint = Component.define(
      "st/Faint2",
      { seconds: Field.f32 },
      { storage: "sparse" }
    );
    const world = new World();
    const one = world.spawn(
      Mixed.of({ x: 1.5, hp: 4, name: "one" }),
      Faint.of({ seconds: 2.5 })
    );
    world.set(one, Mixed, { x: undefined, hp: 6 } as never);
    expect(world.get(one, Mixed)).toEqual({ x: 1.5, hp: 6, name: "one" });
    world.set(one, Mixed, { hp: undefined, x: 8 } as never);
    expect(world.get(one, Mixed)).toEqual({ x: 8, hp: 6, name: "one" });
    world.set(one, Faint, { seconds: undefined } as never);
    expect(world.get(one, Faint)).toEqual({ seconds: 2.5 });
    // A field that holds anything holds nothing when it is told to.
    world.set(one, Mixed, { name: undefined });
    expect(world.get(one, Mixed)).toEqual({ x: 8, hp: 6, name: undefined });
    // And a number that is given is written, zero among them.
    world.set(one, Mixed, { x: 0, hp: 0 });
    expect(world.get(one, Mixed)).toEqual({ x: 0, hp: 0, name: undefined });
  });

  it("stores arbitrary values and entity references", () => {
    const world = new World();
    const a = world.spawn(Name.of({ value: "goblin" }));
    const b = world.spawn(
      Name.of({ value: "archer" }),
      Target.of({ entity: a })
    );
    expect(world.get(b, Name)).toEqual({ value: "archer" });
    const target = world.live(world.get(b, Target)!.entity)!;
    expect(target).toBe(a);
    expect(world.get(target, Name)).toEqual({ value: "goblin" });
  });

  it("turns a stored reference back into its entity while it lives, and never after its slot is reused", () => {
    const world = new World();
    const goblin = world.spawn(Name.of({ value: "goblin" }));
    const archer = world.spawn(Target.of({ entity: goblin }));
    const ref = world.get(archer, Target)!.entity;
    // @ts-expect-error a stored reference is no entity until live says it is
    world.get(ref, Name);
    // A field takes a reference as it is, and an entity.
    const scout = world.spawn(Target.of({ entity: ref }));
    expect(world.live(world.get(scout, Target)!.entity)).toBe(goblin);
    expect(world.live(ref)).toBe(goblin);

    world.despawn(goblin);
    expect(world.live(ref)).toBeUndefined();
    const ogre = world.spawn(Name.of({ value: "ogre" }));
    expect(entityIndex(ogre)).toBe(entityIndex(goblin));
    expect(world.live(ref)).toBeUndefined();
    world.set(archer, Target, { entity: ogre });
    expect(world.live(world.get(archer, Target)!.entity)).toBe(ogre);
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

  it("refuses two different components with one name, in the world that meets both", () => {
    // Defining is not the error: another world, or another app in the same
    // process, can use a component of the same name.
    const mine = Component.define("st/Clash", { x: Field.f32 });
    const theirs = Component.define("st/Clash", { x: Field.f32 });
    const tag = Component.tag("st/Clash", { storage: "sparse" });
    const world = new World();
    const entity = world.spawn(mine.of({ x: 1 }));
    expect(() => world.spawn(theirs.of({ x: 2 }))).toThrow(
      /both named "st\/Clash"/
    );
    expect(() => world.add(entity, theirs.of({ x: 2 }))).toThrow(/both named/);
    expect(() => world.add(entity, tag)).toThrow(/both named/);
    expect(() => world.view(query([theirs]))).toThrow(/both named/);
    expect(() => world.view(query([], [theirs]))).toThrow(/both named/);
    expect(() => world.view(query([], [], [tag]))).toThrow(/both named/);
    // A table component that a query only excludes is met there too.
    expect(() => world.view(query([], [], [theirs]))).toThrow(/both named/);
    expect(() => world.register(theirs)).toThrow(/both named/);
    // Through a command buffer the refusal comes when the command is queued,
    // where the mistake is, and nothing is queued.
    const commands = new CommandBuffer(world);
    expect(() => commands.spawn(mine, theirs)).toThrow(/both named/);
    expect(() => commands.add(entity, theirs)).toThrow(/both named/);
    expect(commands.size).toBe(0);
    // A refused component leaves the world as it was.
    expect(world.entityCount).toBe(1);
    expect(world.get(entity, mine)).toEqual({ x: 1 });
    expect(world.has(entity, theirs)).toBe(false);

    const other = new World();
    const there = other.spawn(theirs.of({ x: 2 }));
    expect(other.get(there, theirs)).toEqual({ x: 2 });
    expect(() => other.spawn(mine)).toThrow(/both named/);
  });

  it("finds a component by its name once the world has met it", () => {
    const world = new World();
    expect(world.component("st/Position")).toBeUndefined();
    world.spawn(Position);
    expect(world.component("st/Position")).toBe(Position);
    // Sparse components and query terms are met without any entity.
    world.view(query([Health], [], [Stunned]));
    expect(world.component("st/Health")).toBe(Health);
    expect(world.component("st/Stunned")).toBe(Stunned);
    // Registering by hand is for looking one up before it is used.
    world.register(Name);
    world.register(Name);
    expect(world.component("st/Name")).toBe(Name);
    expect(world.component("st/Nothing")).toBeUndefined();
  });

  it("makes no component of a name the compiler knows only as a string", () => {
    const name: string = "st/Computed";
    void (() => [
      // @ts-expect-error a component's name is a literal
      Component.define(name, { v: Field.f32 }),
      // @ts-expect-error a component's name is a literal
      Component.tag(name),
      // @ts-expect-error a component's name is a literal
      Component.relation(name, { onTargetDespawn: "remove" }),
    ]);
    const variant = (n: 1 | 2) => Component.tag(`st/Variant${n}`);
    expect(variant(1).name).toBe("st/Variant1");
  });
});

describe("required components", () => {
  const Size = Component.define(
    "st/Size",
    { w: Field.f32 },
    { initial: { w: 1 } }
  );
  const Body = Component.define("st/Body", {}, { requires: [Position, Size] });
  const Rock = Component.define(
    "st/Rock",
    { hp: Field.i32 },
    { requires: [Body, Size.of({ w: 2 })] }
  );
  const Big = Component.tag("st/Big", { requires: [Size.of({ w: 3 })] });
  const Huge = Component.tag("st/Huge", { requires: [Size.of({ w: 4 })] });
  const Lit = Component.tag("st/Lit", { requires: [Burning] });

  it("name what they fill, at any depth, and nothing for a component that requires none", () => {
    expectTypeOf<RequiredOf<typeof Rock>>().toEqualTypeOf<
      "st/Body" | "st/Position" | "st/Size"
    >();
    expectTypeOf<RequiredOf<ReturnType<typeof Rock.of>>>().toEqualTypeOf<
      "st/Body" | "st/Position" | "st/Size"
    >();
    expectTypeOf<RequiredOf<typeof Health>>().toEqualTypeOf<never>();
    expectTypeOf<RequiredOf<typeof Enemy>>().toEqualTypeOf<never>();
    expectTypeOf<
      RequiredOf<ReturnType<typeof Health.of>>
    >().toEqualTypeOf<never>();
    // Without exactOptionalPropertyTypes, an optional property is also
    // undefined: a component that requires nothing still names none.
    expectTypeOf<
      RequiredOf<{ readonly _requires?: readonly [never] | undefined }>
    >().toEqualTypeOf<never>();
  });

  it("fill what a spawn leaves out: zeros, the initial value, and the value required", () => {
    const world = new World();
    const rock = world.spawn(Rock);
    expect(world.has(rock, Body)).toBe(true);
    expect(world.get(rock, Position)).toEqual({ x: 0, y: 0 });
    // Rock's own Size.of beats the bare Size its Body requires.
    expect(world.get(rock, Size)).toEqual({ w: 2 });
    expect(world.get(world.spawn(Body), Size)).toEqual({ w: 1 });
  });

  it("keep a component given at the spawn over the one they would fill", () => {
    const world = new World();
    const rock = world.spawn(Rock, Position.of({ x: 5, y: 0 }), Size);
    expect(world.get(rock, Position)).toEqual({ x: 5, y: 0 });
    expect(world.get(rock, Size)).toEqual({ w: 1 });
    const later = world.spawn(Size.of({ w: 9 }), Rock);
    expect(world.get(later, Size)).toEqual({ w: 9 });
  });

  it("take the later input's value when two fill one component", () => {
    const world = new World();
    expect(world.get(world.spawn(Big, Huge), Size)).toEqual({ w: 4 });
    expect(world.get(world.spawn(Huge, Big), Size)).toEqual({ w: 3 });
  });

  it("take, of two a component inherits, the later", () => {
    const Both = Component.tag("st/Both", { requires: [Big, Huge] });
    const world = new World();
    expect(world.get(world.spawn(Both), Size)).toEqual({ w: 4 });
  });

  it("fill on add only what the entity lacks, in one move", () => {
    const world = new World();
    const e = world.spawn(Health, Position.of({ x: 7, y: 1 }));
    const tables = world.tables.length;
    world.add(e, Rock);
    expect(world.tables.length).toBe(tables + 1);
    expect(world.get(e, Position)).toEqual({ x: 7, y: 1 });
    expect(world.get(e, Size)).toEqual({ w: 2 });
    expect(world.has(e, Body)).toBe(true);
  });

  it("let a required component be removed, and fill it again when the component is added again", () => {
    const world = new World();
    const rock = world.spawn(Rock.of({ hp: 3 }));
    expect(world.remove(rock, Position)).toBe(true);
    expect(world.has(rock, Rock)).toBe(true);
    expect(world.has(rock, Position)).toBe(false);
    world.add(rock, Rock);
    expect(world.get(rock, Position)).toEqual({ x: 0, y: 0 });
    expect(world.get(rock, Rock)).toEqual({ hp: 3 });
  });

  it("fill a sparse component, on spawn and on add", () => {
    const world = new World();
    expect(world.has(world.spawn(Lit), Burning)).toBe(true);
    const e = world.spawn(Health, Burning.of({ seconds: 5 }));
    world.add(e, Lit);
    expect(world.get(e, Burning)).toEqual({ seconds: 5 });
    const bare = world.spawn(Health);
    world.add(bare, Lit);
    expect(world.get(bare, Burning)).toEqual({ seconds: 0 });
  });

  it("fill through a command buffer", () => {
    const world = new World();
    const commands = new CommandBuffer(world);
    const rock = commands.spawn(Rock);
    const e = world.spawn(Health);
    commands.add(e, Lit);
    commands.apply();
    expect(world.has(rock, Position)).toBe(true);
    expect(world.has(e, Burning)).toBe(true);
  });

  it("refuse a relation and a singleton, in the type and when the type is gone round", () => {
    const ChildOf = Component.relation("st/RequiredChildOf", {
      onTargetDespawn: "despawn",
    });
    const Score = Component.singleton(
      "st/RequiredScore",
      { n: Field.i32 },
      {
        n: 0,
      }
    );
    expect(() =>
      Component.define(
        "st/Hanging",
        {},
        {
          // @ts-expect-error a relation has no target to fill in
          requires: [ChildOf],
        }
      )
    ).toThrow(/"st\/RequiredChildOf" can't be required/);
    expect(() =>
      Component.define(
        "st/Scored",
        {},
        {
          // @ts-expect-error no entity has a singleton
          requires: [Score.component],
        }
      )
    ).toThrow(/"st\/RequiredScore" can't be required/);
  });

  it("refuse a spawn whose requirement has the name of another of the world's components, and leave no entity", () => {
    const world = new World();
    world.spawn(Component.tag("st/Twice"));
    const Twin = Component.tag("st/Twin", {
      requires: [Component.tag("st/Twice")],
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() => world.spawn(Twin)).toThrow(/both named "st\/Twice"/);
    }
    expect(world.entityCount).toBe(1);
  });

  it("fill nothing when a world loads a save, and hash as a world without the requirement", () => {
    const before = new World();
    const Old = Component.tag("st/Saved");
    before.spawn(Old, Health.of({ hp: 2 }));
    const bytes = before.snapshot();
    const New = Component.tag("st/Saved", { requires: [Position] });
    const after = new World();
    after.load(bytes, [New]);
    const [only] = after.view(query([New])).entities();
    expect(after.has(only!, Position)).toBe(false);
    expect(after.hash()).toBe(before.hash());
  });
});

describe("queries", () => {
  it("resolves only a description that Query made", () => {
    const world = new World();
    void (() =>
      world.view(
        // @ts-expect-error only Query makes a description
        { terms: [Position] as const, withDefs: [], withoutDefs: [] }
      ));
    expect(world.view(query([Position])).count()).toBe(0);
  });

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
    expect(seen.sort((a, b) => idOf(a) - idOf(b))).toEqual(
      [a, b].sort((a, b) => idOf(a) - idOf(b))
    );
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

  it("keeps one view per description, however many objects say it", () => {
    const world = new World();
    const first = world.view(query([Position], [Enemy], [Stunned]));
    for (let i = 0; i < 1000; i++) {
      expect(world.view(query([Position], [Enemy], [Stunned]))).toBe(first);
    }
    expect(world.view(query([Position], [Enemy]))).not.toBe(first);
    expect(
      world.view(query([Position, Velocity], [], [], { readDefs: [Velocity] }))
    ).not.toBe(world.view(query([Position, Velocity])));
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
        .sort((a, b) => idOf(a) - idOf(b))
    ).toEqual([enemy, stunned].sort((a, b) => idOf(a) - idOf(b)));
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
      seen.push(`${idOf(entity)}:${pos.x}:${burn.seconds}`);
      burn.seconds -= pos.x;
    });
    expect(seen.sort()).toEqual([`${idOf(a)}:1:5`, `${idOf(c)}:3:9`].sort());
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

describe("what each hands its callback", () => {
  // One field of every kind a column can be.
  const fields = {
    f32: Field.f32,
    f64: Field.f64,
    i32: Field.i32,
    u32: Field.u32,
    u16: Field.u16,
    u8: Field.u8,
    entity: Field.entity,
    json: Field.json<string>(),
    ref: Field.ref<Date>({
      encode: (date) => date.getTime(),
      decode: (time) => new Date(time as number),
    }),
    transient: Field.transient<{ readonly n: number }>(),
  };
  const Every = Component.define("st/Every", fields);
  const EverySparse = Component.define("st/EverySparse", fields, {
    storage: "sparse",
  });
  /** A value that is a different one in every field for every `n`. */
  const valueOf = (n: number) => ({
    f32: n + 0.5,
    f64: n + 0.1,
    i32: -n - 1,
    u32: 3_000_000_000 + n,
    u16: 60_000 + n,
    u8: (200 + n) & 255,
    entity: entityOf(n + 7),
    json: `text ${n}`,
    ref: new Date(1000 * n),
    transient: { n },
  });
  const names = Object.keys(fields) as (keyof typeof fields)[];

  for (const def of [Every, EverySparse]) {
    it(`reads and writes a field of every kind, each in its own column and at its own row (${def.storage})`, () => {
      const world = new World();
      const entities: Entity[] = [];
      for (let n = 0; n < 40; n++) {
        // A second table, and rows of the sparse set that are not the
        // table's: every third entity has no such component.
        const extra = n % 2 === 0 ? [Enemy] : [];
        entities.push(
          n % 3 === 2
            ? world.spawn(Health.of({ hp: n }), ...extra)
            : world.spawn(Health.of({ hp: n }), def.of(valueOf(n)), ...extra)
        );
      }
      const having = entities.filter((_, n) => n % 3 !== 2);
      const view = world.view(query([Health, def]));

      // Read through the accessors: what was spawned, field by field.
      const seen: Entity[] = [];
      view.each((health, every, entity) => {
        seen.push(entity);
        const expected = valueOf(health.hp);
        for (const name of names) {
          expect(every[name], name).toEqual(expected[name]);
        }
        // What it holds is its fields, and no more.
        expect(Object.keys(every)).toEqual([]);
        expect(names.every((name) => name in every)).toBe(true);
      });
      expect(seen.toSorted((a, b) => idOf(a) - idOf(b))).toEqual(
        having.toSorted((a, b) => idOf(a) - idOf(b))
      );

      // Written through the accessors: what the world then holds.
      view.each((health, every) => {
        const next = valueOf(health.hp + 100);
        for (const name of names) {
          (every as Record<string, unknown>)[name] = next[name];
        }
      });
      for (const entity of having) {
        const n = world.get(entity, Health)!.hp;
        expect(world.get(entity, def)).toEqual(valueOf(n + 100));
      }

      // One field written leaves the others, and the rows beside it.
      const target = having[5]!;
      view.each((_, every, entity) => {
        if (entity === target) {
          every.u16 = 1;
        }
      });
      for (const entity of having) {
        const n = world.get(entity, Health)!.hp;
        expect(world.get(entity, def)).toEqual(
          entity === target ? { ...valueOf(n + 100), u16: 1 } : valueOf(n + 100)
        );
      }
    });

    it(`reads the same through a query that only reads, in a frozen world, and where writes are noticed (${def.storage})`, () => {
      const world = new World();
      // Others first, so that no entity's row is its index.
      for (let n = 0; n < 7; n++) {
        world.spawn(Health.of({ hp: 100 + n }));
      }
      for (let n = 0; n < 12; n++) {
        world.spawn(Health.of({ hp: n }), def.of(valueOf(n)));
      }
      const read = (spec: QuerySpec): unknown[] => {
        const rows: unknown[] = [];
        world.view(spec).each((...args: unknown[]) => {
          const [health, every] = args as [
            { readonly hp: number },
            Record<string, unknown>,
          ];
          rows.push([health.hp, ...names.map((name) => every[name])]);
        });
        return rows;
      };
      const expected = Array.from({ length: 12 }, (_, n) => [
        n,
        ...names.map((name) => valueOf(n)[name]),
      ]);
      const plain = query([Health, def]);
      expect(read(plain)).toEqual(expected);
      expect(read(query([Health, def], [], [], { readDefs: [def] }))).toEqual(
        expected
      );
      world.freeze();
      expect(read(plain)).toEqual(expected);
      world.thaw();
      // A query that watches the component: from now on its writes are noted.
      const watching = world.view(
        query([Health], [], [], { changedDefs: [def] })
      );
      watching.entities();
      expect(read(plain)).toEqual(expected);
      // And every field's assignment is one, noted for the entity it was.
      for (const name of names) {
        const written: Entity[] = [];
        world.view(plain).each((health, every, entity) => {
          if (health.hp % 5 === 0) {
            (every as Record<string, unknown>)[name] = valueOf(health.hp + 50)[
              name
            ];
            written.push(entity);
          }
        });
        expect(watching.entities(), name).toEqual(written);
      }
      expect(read(plain)).toEqual(
        Array.from({ length: 12 }, (_, n) => [
          n,
          ...names.map((name) => valueOf(n % 5 === 0 ? n + 50 : n)[name]),
        ])
      );
    });
  }

  it("reads and writes where the data is after a table or a sparse set has grown between two loops", () => {
    const world = new World();
    const view = world.view(query([Health, Burning]));
    const plain = world.view(query([Health]));
    const entities: Entity[] = [];
    const grow = (upTo: number): void => {
      while (entities.length < upTo) {
        const n = entities.length;
        entities.push(
          world.spawn(Health.of({ hp: n }), Burning.of({ seconds: n / 2 }))
        );
      }
    };
    // A table and a sparse set start with room for sixteen, and move
    // their columns to larger arrays when that is used up.
    for (const count of [10, 16, 17, 40, 200]) {
      grow(count);
      for (const each of [view, plain]) {
        const seen: number[] = [];
        const burnt: number[] = [];
        each.each((...args: unknown[]) => {
          const [health, burning] = args as [
            { hp: number },
            { seconds: number } | number,
          ];
          seen.push(health.hp);
          if (typeof burning === "object") {
            burnt.push(burning.seconds);
            burning.seconds += 0;
          }
          health.hp += 1000;
        });
        expect(seen).toEqual(Array.from({ length: count }, (_, n) => n));
        // Only the loop over both has the second, at the same rows.
        expect(burnt).toEqual(each === view ? seen.map((hp) => hp / 2) : []);
        // The write went where the world reads from.
        each.each((health) => {
          (health as { hp: number }).hp -= 1000;
        });
      }
      for (let n = 0; n < count; n++) {
        expect(world.get(entities[n]!, Health)).toEqual({ hp: n });
        expect(world.get(entities[n]!, Burning)).toEqual({ seconds: n / 2 });
      }
    }
    // And a sparse set that grows on its own, its table as it was.
    const Mark = Component.define(
      "st/Mark",
      { v: Field.i32 },
      { storage: "sparse" }
    );
    const marked = world.view(query([Mark]));
    for (const count of [10, 20, 70]) {
      for (let n = 0; n < count; n++) {
        world.add(entities[n]!, Mark.of({ v: n }));
      }
      const seen: number[] = [];
      marked.each((mark) => {
        seen.push(mark.v);
        mark.v = -mark.v;
      });
      expect(seen.toSorted((a, b) => a - b)).toEqual(
        Array.from({ length: count }, (_, n) => n)
      );
      for (let n = 0; n < count; n++) {
        expect(world.get(entities[n]!, Mark)).toEqual({ v: -n || 0 });
      }
    }
  });

  it("hands four terms and more their own rows, in tables and in sparse sets", () => {
    const world = new World();
    const A = Component.define("st/A", { v: Field.i32 });
    const B = Component.define("st/B", { v: Field.i32 });
    const C = Component.define("st/C", { v: Field.i32 });
    const F = Component.define("st/F", { v: Field.i32 });
    const D = Component.define("st/D", { v: Field.i32 }, { storage: "sparse" });
    const E = Component.define("st/E", { v: Field.i32 }, { storage: "sparse" });
    const entities: Entity[] = [];
    for (let n = 0; n < 30; n++) {
      entities.push(
        world.spawn(
          A.of({ v: n }),
          B.of({ v: 10 * n }),
          C.of({ v: 100 * n }),
          F.of({ v: 100_000 * n })
        )
      );
    }
    // The sparse sets in two other orders than the table's rows.
    for (let n = 29; n >= 0; n--) {
      world.add(entities[n]!, D.of({ v: 1000 * n }));
    }
    for (const n of [
      3,
      1,
      2,
      0,
      ...Array.from({ length: 26 }, (_, k) => k + 4),
    ]) {
      world.add(entities[n]!, E.of({ v: 10_000 * n }));
    }
    // Components of one shape and several names: told apart nowhere here.
    const lists: ComponentDef[][] = [
      // In the table alone: one loop for each number of terms up to three,
      // and one for any number past that.
      [B],
      [B, A],
      [C, A, B],
      [A, B, C, F],
      [F, C, B, A, B],
      // With terms that are sparse, whose rows are their own.
      [A, B, C, D],
      [A, B, C, D, E],
      [D, E],
      [D, A, E],
      [E],
    ];
    for (const terms of lists) {
      const rows: number[][] = [];
      world.view(query(terms)).each((...args: unknown[]) => {
        const entity = args.pop() as Entity;
        const n = entities.indexOf(entity);
        rows.push([n, ...args.map((term) => (term as { v: number }).v)]);
        for (const term of args) {
          (term as { v: number }).v += 1;
        }
      });
      const scale = new Map<ComponentDef, number>([
        [A, 1],
        [B, 10],
        [C, 100],
        [D, 1000],
        [E, 10_000],
        [F, 100_000],
      ]);
      expect(rows.length).toBe(30);
      for (const [n, ...values] of rows) {
        // A term that is there twice was handed out twice, and added to
        // twice.
        expect(values).toEqual(
          terms.map(
            (def) =>
              (world.get(entities[n!]!, def) as { readonly v: number }).v -
              terms.filter((other) => other === def).length
          )
        );
        // Whatever was added so far, each value is still its own entity's.
        for (let k = 0; k < terms.length; k++) {
          const of = scale.get(terms[k]!)!;
          expect(Math.floor(values[k]! / of) % 10 === n! % 10 || of === 1).toBe(
            true
          );
        }
      }
    }
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

  const refusing: [string, (world: World, apply: () => unknown) => void][] = [
    [
      "while a query is iterating",
      (world, apply) => {
        world.view(query([Health])).each(() => {
          apply();
        });
      },
    ],
    [
      "inside a transaction",
      (world, apply) => {
        world.begin();
        try {
          apply();
        } finally {
          world.rollback();
        }
      },
    ],
    [
      "in a frozen world",
      (world, apply) => {
        world.freeze();
        try {
          apply();
        } finally {
          world.thaw();
        }
      },
    ],
  ];

  it.each(refusing)(
    "refuses to apply %s, and keeps every command for a later apply",
    (_, inside) => {
      const world = new World();
      const commands = new CommandBuffer(world);
      const kept = world.spawn(Health.of({ hp: 1 }), Enemy);
      const gone = world.spawn(Health.of({ hp: 2 }));
      const spawned = commands.spawn(Health.of({ hp: 3 }));
      commands.despawn(gone);
      commands.add(kept, Stunned);
      commands.remove(kept, Enemy);
      const before = world.hash();

      expect(() => inside(world, () => commands.apply())).toThrow(
        /CommandBuffer\.apply\(\)/
      );
      expect(commands.size).toBe(4);
      expect(world.hash()).toBe(before);
      expect(world.has(spawned, Health)).toBe(false);

      expect(commands.apply()).toBe(4);
      expect(world.get(spawned, Health)).toEqual({ hp: 3 });
      expect(world.isAlive(gone)).toBe(false);
      expect(world.has(kept, Stunned)).toBe(true);
      expect(world.has(kept, Enemy)).toBe(false);
    }
  );
});

describe("randomized comparison against a simple model", () => {
  // A second, obviously-correct implementation: a Map of entity -> components.
  // Thousands of random operations must leave both in the same state.
  const Armored = Component.define(
    "st/Armored",
    { plates: Field.i32 },
    { requires: [Health.of({ hp: 100 }), Stunned] }
  );
  /** What the model fills in for a component, by the id of the one filled. */
  const fills = new Map<
    number,
    readonly (readonly [number, Record<string, number>])[]
  >([
    [
      Armored.id,
      [
        [Health.id, { hp: 100 }],
        [Stunned.id, {}],
      ],
    ],
  ]);
  // As any component: the model holds plain objects, whatever the component.
  const defs: readonly ComponentDef[] = [
    Position,
    Velocity,
    Health,
    Enemy,
    Stunned,
    Burning,
    Armored,
  ];
  const random = (seed: number) => () => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return seed / 0x1_00_00_00_00;
  };
  const sample = (
    def: ComponentDef,
    rnd: () => number
  ): Record<string, number> => {
    if (def === Position || def === Velocity) {
      return { x: Math.fround(rnd() * 100), y: Math.fround(rnd() * 100) };
    }
    if (def === Health) {
      return { hp: Math.floor(rnd() * 1000) };
    }
    if (def === Burning) {
      return { seconds: Math.fround(rnd() * 10) };
    }
    if (def === Armored) {
      return { plates: Math.floor(rnd() * 10) };
    }
    return {};
  };

  for (const seed of [1, 2, 3, 4, 5]) {
    it(`seed ${seed}`, () => {
      const rnd = random(seed);
      const world = new World();
      const model = new Map<Entity, Map<number, Record<string, number>>>();
      const dead: Entity[] = [];
      const checks = makeChecks();

      for (let step = 0; step < 4000; step++) {
        const roll = rnd();
        const live = [...model.keys()];
        const pick =
          live.length > 0 ? live[Math.floor(rnd() * live.length)] : undefined;
        const def = defs[Math.floor(rnd() * defs.length)]!;
        if (roll < 0.3 || pick === undefined) {
          const chosen = defs.filter(() => rnd() < 0.4);
          const values = new Map<number, Record<string, number>>();
          const inputs = chosen.map((d) => {
            const value = sample(d, rnd);
            values.set(d.id, value);
            return d.of(value);
          });
          const filled = new Map<number, Record<string, number>>();
          for (const d of chosen) {
            for (const [id, value] of fills.get(d.id) ?? []) {
              filled.set(id, value);
            }
          }
          for (const [id, value] of filled) {
            if (!values.has(id)) {
              values.set(id, value);
            }
          }
          model.set(world.spawn(...inputs), values);
        } else if (roll < 0.45) {
          checks.check(`step ${step}: despawned`, world.despawn(pick), true);
          model.delete(pick);
          dead.push(pick);
        } else if (roll < 0.75) {
          const value = sample(def!, rnd);
          world.add(pick, def.of(value));
          const values = model.get(pick)!;
          values.set(def.id, value);
          for (const [id, filled] of fills.get(def.id) ?? []) {
            if (!values.has(id)) {
              values.set(id, filled);
            }
          }
        } else {
          checks.check(
            `step ${step}: removed ${def.name}`,
            world.remove(pick, def),
            model.get(pick)!.delete(def.id)
          );
        }
      }
      expectChecked(checks, 1000);

      expect(world.entityCount).toBe(model.size);
      for (const entity of dead) {
        expect(world.isAlive(entity)).toBe(false);
      }
      for (const [entity, values] of model) {
        expect(world.isAlive(entity)).toBe(true);
        for (const def of defs) {
          expect(world.has(entity, def)).toBe(values.has(def.id));
          expect(world.get(entity, def)).toEqual(values.get(def.id));
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
            .sort((a, b) => idOf(a) - idOf(b));
          const view = world.view(query([required], [], [excluded]));
          expect(view.entities().sort((a, b) => idOf(a) - idOf(b))).toEqual(
            expected
          );
          expect(view.count()).toBe(expected.length);
          const visited: Entity[] = [];
          view.each((_, entity) => {
            visited.push(entity);
          });
          expect(visited.sort((a, b) => idOf(a) - idOf(b))).toEqual(expected);
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
            .sort((a, b) => idOf(a) - idOf(b));
          const view = world.view(query([Position], [sparse], [Enemy]));
          view._path = path;
          const visited: Entity[] = [];
          view.each((pos, entity) => {
            expect(pos.x).toBe(model.get(entity)!.get(Position.id)!.x);
            visited.push(entity);
          });
          expect(visited.sort((a, b) => idOf(a) - idOf(b))).toEqual(expected);
          const chunked: Entity[] = [];
          view.eachChunk((start, end, pos, entities) => {
            expect(end).toBeGreaterThan(start);
            for (let i = start; i < end; i++) {
              const entity = entities[i]!;
              expect(pos.y[i]).toBe(model.get(entity)!.get(Position.id)!.y);
              chunked.push(entity);
            }
          });
          expect(chunked.sort((a, b) => idOf(a) - idOf(b))).toEqual(expected);
        }

        const expected = [...model]
          .filter(
            ([, values]) =>
              values.has(Health.id) &&
              values.has(Burning.id) &&
              !values.has(Stunned.id)
          )
          .map(([entity]) => entity)
          .sort((a, b) => idOf(a) - idOf(b));
        const view = world.view(query([Health, Burning], [], [Stunned]));
        view._path = path;
        const visited: Entity[] = [];
        view.each((health, burn, entity) => {
          expect(health.hp).toBe(model.get(entity)!.get(Health.id)!.hp);
          expect(burn.seconds).toBe(
            model.get(entity)!.get(Burning.id)!.seconds
          );
          visited.push(entity);
        });
        expect(visited.sort((a, b) => idOf(a) - idOf(b))).toEqual(expected);
        const chunked: Entity[] = [];
        view.eachChunk((start, end, health, burning, entities) => {
          for (let i = start; i < end; i++) {
            const entity = entities[i]!;
            expect(health.hp[i]).toBe(model.get(entity)!.get(Health.id)!.hp);
            expect(burning.columns.seconds[burning.indexOf(entity)]).toBe(
              model.get(entity)!.get(Burning.id)!.seconds
            );
            chunked.push(entity);
          }
        });
        expect(chunked.sort((a, b) => idOf(a) - idOf(b))).toEqual(expected);
      }

      // A sparse `without` must split raw chunks without losing or adding rows.
      const awake = [...model]
        .filter(
          ([, values]) => values.has(Position.id) && !values.has(Stunned.id)
        )
        .map(([entity]) => entity)
        .sort((a, b) => idOf(a) - idOf(b));
      const chunked: Entity[] = [];
      world
        .view(query([Position], [], [Stunned]))
        .eachChunk((start, end, _pos, entities) => {
          for (let i = start; i < end; i++) {
            chunked.push(entities[i]!);
          }
        });
      expect(chunked.sort((a, b) => idOf(a) - idOf(b))).toEqual(awake);

      // A term an entity may lack hands out its data or undefined, entity by
      // entity as the model has it, and doesn't decide which entities match.
      const valueOf = (entity: Entity, def: ComponentDef): unknown =>
        model.get(entity)!.get(def.id);
      for (const Maybes of [
        all(Position, maybe(Velocity), maybe(Health)),
        all(Position, maybe(Velocity), maybe(Health)).pipe(without(Stunned)),
      ]) {
        const expected = [...model]
          .filter(
            ([, values]) =>
              values.has(Position.id) &&
              (Maybes.withoutDefs.length === 0 || !values.has(Stunned.id))
          )
          .map(([entity]) => entity)
          .sort((a, b) => idOf(a) - idOf(b));
        const view = world.view(Maybes);
        const visited: Entity[] = [];
        view.each((_pos, velocity, health, entity) => {
          expect(
            velocity === undefined
              ? undefined
              : { x: velocity.x, y: velocity.y }
          ).toEqual(valueOf(entity, Velocity));
          expect(health === undefined ? undefined : { hp: health.hp }).toEqual(
            valueOf(entity, Health)
          );
          visited.push(entity);
        });
        expect(visited.sort((a, b) => idOf(a) - idOf(b))).toEqual(expected);
        const chunked: Entity[] = [];
        view.eachChunk((start, end, _pos, velocity, health, entities) => {
          for (let i = start; i < end; i++) {
            const entity = entities[i]!;
            expect(
              velocity === undefined
                ? undefined
                : { x: velocity.x[i], y: velocity.y[i] }
            ).toEqual(valueOf(entity, Velocity));
            expect(
              health === undefined ? undefined : { hp: health.hp[i] }
            ).toEqual(valueOf(entity, Health));
            chunked.push(entity);
          }
        });
        expect(chunked.sort((a, b) => idOf(a) - idOf(b))).toEqual(expected);
      }
    });
  }
});
