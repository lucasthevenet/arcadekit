import { Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  Component,
  entityGeneration,
  entityIndex,
  Field,
  readSnapshot,
  SnapshotError,
  World,
  writeSnapshot,
} from "../src/ecs/index";
import type { Entity, QuerySpec, Terms } from "../src/ecs/index";
import { EntityId, Migrate } from "../src/index";

const Body = Component.define("id/Body", { x: Field.f32 });
const Owned = Component.define("id/Owned", { by: Field.entity, n: Field.u16 });
const ChildOf = Component.relation("id/ChildOf", {
  onTargetDespawn: "despawn",
});
const Mark = Component.define(
  "id/Mark",
  { to: Field.entity },
  { storage: "sparse" }
);
const Count = Component.singleton(
  "id/Count",
  { n: Field.i32, last: Field.entity },
  { n: 0, last: 0 as Entity }
);
const all = [Body, Owned, ChildOf, Mark, Count.component];

const query = <const D extends Terms>(
  terms: D,
  more: Partial<QuerySpec<D>> = {}
): QuerySpec<D> => ({ terms, withDefs: [], withoutDefs: [], ...more });

/** What an id's generation is multiplied by: 2^22, the number of slots. */
const SLOTS = 2 ** 22;
/** The generations a slot has. */
const GENERATIONS = 2 ** 31;

/** Gives one slot out and takes it back, `times` over, and gives it out once more. */
const worn = (world: World, times: number): Entity => {
  for (let n = 0; n < times; n++) {
    world.despawn(world.spawn(Body.of({ x: n })));
  }
  return world.spawn(Body.of({ x: -1 }));
};

describe("an entity's id", () => {
  it("names nobody once its entity is gone, however often its slot is given out again", () => {
    const world = new World();
    const seen = new Set<number>();
    const kept: Entity[] = [];
    // Past the 1,024 times at which an id of 32 bits came round again.
    for (let n = 0; n < 3000; n++) {
      const entity = world.spawn(Body.of({ x: n }));
      expect(entityIndex(entity)).toBe(0);
      expect(entityGeneration(entity)).toBe(n);
      expect(seen.has(entity), `given out twice: ${entity}`).toBe(false);
      seen.add(entity);
      if (n % 97 === 0 || n === 1023 || n === 1024 || n === 2048) {
        kept.push(entity);
      }
      world.despawn(entity);
      for (const old of kept) {
        expect(world.isAlive(old)).toBe(false);
      }
    }
    const last = world.spawn(Body.of({ x: 7 }));
    expect(entityGeneration(last)).toBe(3000);
    for (const old of kept) {
      expect(world.isAlive(old)).toBe(false);
      expect(world.get(old, Body)).toBeUndefined();
      expect(world.has(old, Body)).toBe(false);
      expect(world.set(old, Body, { x: 0 })).toBe(false);
      expect(world.despawn(old)).toBe(false);
    }
    expect(world.get(last, Body)).toEqual({ x: 7 });
    expect(world.entityCount).toBe(1);
    // Nor does a number that is no id at all, though its low bits are a
    // slot that is taken.
    for (const never of [last + 0.5, -1, Number.NaN, 2 ** 53 + last, 0.25]) {
      expect(world.isAlive(never as Entity), String(never)).toBe(false);
      expect(world.get(never as Entity, Body)).toBeUndefined();
    }
  });

  it("is its slot and, above the slot's 22 bits, how often the slot was given out before", () => {
    const world = new World();
    world.spawn(Body.of({ x: 0 }));
    const second = world.spawn(Body.of({ x: 1 }));
    expect([entityIndex(second), entityGeneration(second)]).toEqual([1, 0]);
    world.despawn(second);
    const again = world.spawn(Body.of({ x: 2 }));
    expect(again).toBe(SLOTS + 1);
    expect([entityIndex(again), entityGeneration(again)]).toEqual([1, 1]);
    // An id of the first 1,024 generations is the number it always was.
    world.despawn(again);
    const narrow = worn(world, 1021);
    expect(narrow).toBe(1023 * SLOTS + 1);
    expect(narrow).toBeLessThan(2 ** 32);
    // And the next is past what 32 bits hold.
    world.despawn(narrow);
    const wide = world.spawn(Body.of({ x: 0 }));
    expect(wide).toBe(1024 * SLOTS + 1);
    expect(wide).toBeGreaterThan(2 ** 32);
    expect([entityIndex(wide), entityGeneration(wide)]).toEqual([1, 1024]);
    expect(Number.isSafeInteger(wide)).toBe(true);
  });

  it("is whole wherever it is kept, when it is past what 32 bits hold", () => {
    const world = new World({ seed: 5 });
    const anchor = world.spawn(Body.of({ x: 100 }));
    const wide = worn(world, 1500);
    expect(wide).toBe(1500 * SLOTS + 1);
    // In a field, written each way a field is written.
    const owned = world.spawn(Body.of({ x: 1 }), Owned.of({ by: wide, n: 1 }));
    expect(world.get(owned, Owned)).toEqual({ by: wide, n: 1 });
    world.set(owned, Owned, { by: anchor });
    world.view(query([Owned])).each((held) => {
      expect(held.by).toBe(anchor);
      held.by = wide;
    });
    expect(world.get(owned, Owned)?.by).toBe(wide);
    world.view(query([Owned])).eachChunk((start, end, columns, entities) => {
      expect(columns.by).toBeInstanceOf(Float64Array);
      expect(entities).toBeInstanceOf(Float64Array);
      for (let i = start; i < end; i++) {
        expect(columns.by[i]).toBe(wide);
        expect(entities[i]).toBe(owned);
      }
    });
    // In a table's rows, as a loop hands them out.
    const handed: Entity[] = [];
    world.view(query([Body])).each((_, entity) => {
      handed.push(entity);
    });
    expect(handed).toEqual([anchor, wide, owned]);
    expect(world.view(query([Body])).entities()).toEqual(handed);
    // In a sparse set, a relation and a singleton.
    world.add(wide, Mark.of({ to: wide }));
    world.add(anchor, Mark.of({ to: owned }));
    expect(world.get(wide, Mark)).toEqual({ to: wide });
    const marked: [Entity, Entity][] = [];
    world.view(query([Mark])).each((mark, entity) => {
      marked.push([entity, mark.to]);
    });
    expect(marked).toEqual([
      [anchor, owned],
      [wide, wide],
    ]);
    const child = world.spawn(ChildOf.of({ target: wide }));
    expect(world.get(child, ChildOf)).toEqual({ target: wide });
    expect(world.sources(wide, ChildOf)).toEqual([child]);
    world.singleton(Count).last = wide;
    expect(world.singleton(Count).last).toBe(wide);

    // In a snapshot, and in a world that loads it or is put back to it.
    const hash = world.hash();
    const bytes = world.snapshot();
    const copy = new World();
    copy.load(bytes, all);
    for (const each of [copy, world]) {
      if (each === world) {
        world.despawn(owned);
        world.restore(bytes);
      }
      expect(each.hash()).toBe(hash);
      expect(each.isAlive(wide)).toBe(true);
      expect(each.view(query([Body])).entities()).toEqual(handed);
      expect(each.get(owned, Owned)).toEqual({ by: wide, n: 1 });
      expect(each.get(wide, Mark)).toEqual({ to: wide });
      expect(each.sources(wide, ChildOf)).toEqual([child]);
      expect(each.singleton(Count).last).toBe(wide);
    }
    const contents = readSnapshot(bytes);
    expect(contents.generations).toBeInstanceOf(Uint32Array);
    expect(Array.from(contents.generations)).toEqual([0, 1500, 0, 0]);
    expect(Array.from(contents.tables[0]!.entities)).toEqual([anchor, wide]);
    expect(writeSnapshot(contents)).toEqual(bytes);
    // A different id in a field is a different world, though they differ
    // only above their 32nd bit: in a table, and in a sparse set.
    copy.set(owned, Owned, { by: (wide + 2 ** 32) as Entity });
    expect(copy.hash()).not.toBe(hash);
    copy.set(owned, Owned, { by: wide });
    expect(copy.hash()).toBe(hash);
    copy.set(wide, Mark, { to: (wide + 2 ** 32) as Entity });
    expect(copy.hash()).not.toBe(hash);
    copy.set(wide, Mark, { to: wide });
    expect(copy.hash()).toBe(hash);

    // Among what was removed, in what changed, and through commands.
    const gone = world.removed(Body);
    const changed = world.view(query([Body], { changedDefs: [Body] }));
    changed.entities();
    world.set(wide, Body, { x: 9 });
    expect(changed.entities()).toEqual([wide]);
    // Its child goes with it. What a reader has yet to hear of is kept
    // whole in what a save holds of it.
    world.despawn(wide);
    const unread = world.saveChanges();
    expect(unread.find((each) => each.kind === "removed")?.entries).toEqual([
      wide,
    ]);
    const later = new World();
    later.load(world.snapshot(), all);
    later.restoreChanges(unread);
    expect(later.removed(Body).read()).toEqual([wide]);
    expect(gone.read()).toEqual([wide]);
    expect(world.isAlive(child)).toBe(false);
    // The slots that came free are given out again, last first, each with
    // its next generation.
    expect(world.spawn(Body.of({ x: 3 }))).toBe(SLOTS + entityIndex(child));
    expect(world.spawn(Body.of({ x: 3 }))).toBe(wide + SLOTS);
    expect(world.isAlive(wide)).toBe(false);
  });

  it("is one a schema takes, and a migration can put in a field", () => {
    const decode = Schema.decodeUnknownExit(EntityId);
    const wide = (1500 * SLOTS + 1) as Entity;
    expect(decode(wide)).toEqual(Exit.succeed(wide));
    expect(JSON.parse(JSON.stringify({ wide }))).toEqual({ wide });
    const world = new World();
    world.spawn(Body.of({ x: 1 }));
    const contents = readSnapshot(world.snapshot());
    Migrate.addField(contents, "id/Body", "by", "entity", wide);
    const Bodied = Component.define("id/Body", {
      x: Field.f32,
      by: Field.entity,
    });
    const moved = new World();
    moved.load(writeSnapshot(contents), [Bodied]);
    expect(moved.get(0 as Entity, Bodied)).toEqual({ x: 1, by: wide });
  });
});

describe("a slot whose generations are used up", () => {
  /** A world whose one entity is of its slot's last generation. */
  const atTheLast = (): { readonly world: World; readonly last: Entity } => {
    const first = new World({ seed: 3 });
    first.spawn(Body.of({ x: 1 }));
    first.spawn(Body.of({ x: 2 }));
    first.despawn(1 as Entity);
    const contents = readSnapshot(first.snapshot());
    const last = ((GENERATIONS - 1) * SLOTS) as Entity;
    contents.generations[0] = GENERATIONS - 1;
    contents.tables[0]!.entities[0] = last;
    const world = new World();
    world.load(writeSnapshot(contents), all);
    return { world, last };
  };

  it("is given out no more, so that no id is ever given out twice", () => {
    const { last, world } = atTheLast();
    expect(last).toBeLessThan(2 ** 53);
    expect(Number.isSafeInteger(last)).toBe(true);
    expect(world.isAlive(last)).toBe(true);
    expect(world.get(last, Body)).toEqual({ x: 1 });
    expect(entityGeneration(last)).toBe(GENERATIONS - 1);
    expect(world.despawn(last)).toBe(true);
    expect(world.isAlive(last)).toBe(false);
    expect(world.entityCount).toBe(0);
    // The slot that was freed before is given out, and then new ones: slot
    // 0 is not, ever.
    const next = [0, 1, 2, 3].map((n) => world.spawn(Body.of({ x: n })));
    expect(next.map((entity) => entityIndex(entity))).toEqual([1, 2, 3, 4]);
    for (const entity of next) {
      world.despawn(entity);
    }
    const after = [0, 1, 2, 3, 4].map((n) => world.spawn(Body.of({ x: n })));
    expect(after.map((entity) => entityIndex(entity)).toSorted()).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(world.isAlive(last)).toBe(false);
    expect(world.isAlive(0 as Entity)).toBe(false);
  });

  it("is kept so by a snapshot, and counted in the hash by the slots it leaves", () => {
    const { last, world } = atTheLast();
    world.despawn(last);
    const bytes = world.snapshot();
    const copy = new World();
    copy.load(bytes, all);
    expect(copy.hash()).toBe(world.hash());
    expect(Array.from(readSnapshot(bytes).generations)).toEqual([
      GENERATIONS,
      1,
    ]);
    for (const each of [world, copy]) {
      expect(entityIndex(each.spawn(Body.of({ x: 0 })))).toBe(1);
      expect(entityIndex(each.spawn(Body.of({ x: 0 })))).toBe(2);
      expect(each.isAlive(last)).toBe(false);
    }
    expect(copy.hash()).toBe(world.hash());
    world.restore(bytes);
    expect(entityIndex(world.spawn(Body.of({ x: 0 })))).toBe(1);
    // A snapshot that would give the slot out again is not one a world wrote.
    const contents = readSnapshot(bytes);
    contents.freed = [...contents.freed, 0];
    let problem: unknown;
    try {
      new World().load(writeSnapshot(contents), all);
    } catch (error) {
      problem = error;
    }
    expect(problem).toBeInstanceOf(SnapshotError);
    expect((problem as SnapshotError).message).toMatch(/one that is used up/);
  });
});

describe("a snapshot from before ids were widened", () => {
  // Written by the build before this one, in format 2: a generation is two
  // bytes there and an id four. Slot 2 was given out seven times, slot 4
  // three times and slot 5 twice; slot 1 is free; an id is in a field of a
  // table, in a relation, in a field of a sparse set and in a singleton.
  const old = Uint8Array.from(
    (
      "414b57530200000043aee9c9410977196a87f940dcca89b20700000000000100060000000200" +
      "010000000100000001000000050000000700000069642f426f64790001000000010000007800" +
      "0a00000069642f4368696c644f66000100000006000000746172676574060800000069642f43" +
      "6f756e740202000000010000006e02040000006c617374060700000069642f4d61726b010100" +
      "000002000000746f060800000069642f4f776e6564000200000002000000627906010000006e" +
      "0403000000010000000000000004000000000000000200800104008000030000000000000000" +
      "00c841000024420000404002000000000000000400000001000000050040000000c842020080" +
      "0107000100000001000000010000000600000004008000010000000300000002000000000000" +
      "0004000000020080010500400001000000020000000300000004008000454e4421"
    ).match(/../gu)!,
    (byte) => Number.parseInt(byte, 16)
  );
  // What that build said of the world it wrote, and of the three entities
  // it spawned next.
  const facts = {
    two: 25165826,
    four: 8388612,
    owned: 4194309,
    child: 6,
    alive: 6,
    bodies: [
      [0, 0],
      [25165826, 25],
      [8388612, 41],
      [3, 3],
      [4194309, 100],
    ],
    ownedBy: { by: 25165826, n: 7 },
    childOf: { target: 8388612 },
    sources: [6],
    marks: [
      [0, 25165826],
      [8388612, 4194309],
    ],
    count: { n: 3, last: 8388612 },
    random: [3387534915, 427231553, 1090094954, 2995374812],
    after: [4194305, 7, 8],
  } as unknown as {
    readonly two: Entity;
    readonly four: Entity;
    readonly owned: Entity;
    readonly child: Entity;
    readonly alive: number;
    readonly bodies: readonly (readonly [Entity, number])[];
    readonly ownedBy: { readonly by: Entity; readonly n: number };
    readonly childOf: { readonly target: Entity };
    readonly sources: readonly Entity[];
    readonly marks: readonly (readonly [Entity, Entity])[];
    readonly count: { readonly n: number; readonly last: Entity };
    readonly random: readonly number[];
    readonly after: readonly Entity[];
  };

  it("is read as the world it was: every id the number it was, in a wider place", () => {
    expect(new DataView(old.buffer).getUint32(4, true)).toBe(2);
    const world = new World();
    world.load(old, all);
    expect(world.entityCount).toBe(facts.alive);
    expect(
      world
        .view(query([Body]))
        .entities()
        .map((entity) => [entity, world.get(entity, Body)!.x])
    ).toEqual(facts.bodies);
    expect(entityGeneration(facts.two)).toBe(6);
    expect(world.get(facts.owned, Owned)).toEqual(facts.ownedBy);
    expect(world.get(facts.child, ChildOf)).toEqual(facts.childOf);
    expect(world.sources(facts.four, ChildOf)).toEqual(facts.sources);
    expect(
      facts.marks.map(([entity]) => [entity, world.get(entity, Mark)!.to])
    ).toEqual(facts.marks);
    expect({ ...world.singleton(Count) }).toEqual(facts.count);
    expect(Array.from(world.random.state)).toEqual(facts.random);
    // And it goes on as that world went on: the same ids to come.
    const again = new World();
    again.load(old, all);
    expect([0, 0, 0].map(() => again.spawn(Body.of({ x: 0 })))).toEqual(
      facts.after
    );
  });

  it("is written again in the format of today, which a world reads to the same end", () => {
    const world = new World();
    world.load(old, all);
    const today = world.snapshot();
    expect(new DataView(today.buffer).getUint32(4, true)).toBe(3);
    expect(today.length).toBeGreaterThan(old.length);
    expect(writeSnapshot(readSnapshot(old))).toEqual(today);
    const copy = new World();
    copy.load(today, all);
    expect(copy.hash()).toBe(world.hash());
    const contents = readSnapshot(old);
    expect(Array.from(contents.generations)).toEqual([0, 1, 6, 0, 2, 1, 0]);
    expect(contents.freed).toEqual([1]);
  });
});
