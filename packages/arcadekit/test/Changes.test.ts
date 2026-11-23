import { Cause, Data, Effect, Exit, Schema } from "effect";
import { assert, describe, expect, it } from "vitest";

import type { Terms } from "../src/ecs/query";
import type { Spawned } from "../src/index";
import {
  Action,
  App,
  Commands,
  Component,
  EcsWorld,
  EntityId,
  Field,
  Journal,
  Migrate,
  Plugin,
  Query,
  Save,
  System,
  Time,
  World,
  readSnapshot,
  writeSnapshot,
} from "../src/index";
import type {
  Entity,
  EntityColumn,
  SavedChanges,
  SnapshotContents,
} from "../src/index";
import { expectChecked, makeChecks } from "./checks";
import { placedIn } from "./placed";

/** What the change queries of a snapshot's world had yet to visit. */
const visitsOf = (world: SnapshotContents): SavedChanges[] =>
  (world.stores.find((store) => store.name === Save.VISITS)?.data ??
    []) as SavedChanges[];
const visitsIn = (save: Save.Save): SavedChanges[] =>
  visitsOf(readSnapshot(save.world));

const Position = Component.define("ch/Position", {
  x: Field.f32,
  y: Field.f32,
});
const Health = Component.define("ch/Health", { hp: Field.i32 });
const Sprite = Component.define("ch/Sprite", { frame: Field.u8 });
const Heat = Component.define(
  "ch/Heat",
  { degrees: Field.f32 },
  { storage: "sparse" }
);
const Frozen = Component.tag("ch/Frozen", { storage: "sparse" });
const Boss = Component.tag("ch/Boss");

const Positions = Query.all(Position).pipe(Query.writes(Position));
const Moved = Query.all(Position).pipe(
  Query.changed(Position),
  Query.writes(Position)
);
const Hurt = Query.all(Health).pipe(Query.changed(Health));
const Born = Query.all(Sprite).pipe(Query.added(Sprite));
const Warmed = Query.all(Heat).pipe(Query.changed(Heat));
/** What a save knows the query `Moved` by, after its reader's name. */
const MOVED =
  "all(ch/Position) with() without() changed(ch/Position) added() reads()";

/**
 * A world of `count` entities with a position, the first half of them with
 * health: two tables, which a query visits in the order of `entities`.
 */
const populated = (count = 10): { world: EcsWorld; entities: Entity[] } => {
  const world = new EcsWorld();
  const entities: Entity[] = [];
  for (let n = 0; n < count; n++) {
    entities.push(
      n < count / 2
        ? world.spawn(Position.of({ x: n, y: 0 }), Health.of({ hp: 10 }))
        : world.spawn(Position.of({ x: n, y: 0 }))
    );
  }
  return { world, entities };
};

describe("a change query", () => {
  it("visits every entity that matches the first time, and after that only what was written", () => {
    const { entities, world } = populated();
    const moved = world.view(Moved);
    expect(moved.entities()).toEqual(entities);
    expect(moved.entities()).toEqual([]);

    world.set(entities[7]!, Position, { x: 70 });
    world.set(entities[2]!, Position, { y: 20 });
    const seen: [Entity, number, number][] = [];
    moved.each((pos, entity) => {
      seen.push([entity, pos.x, pos.y]);
    });
    // In the order any query visits them, not the order they were written in.
    expect(seen).toEqual([
      [entities[2], 2, 20],
      [entities[7], 70, 0],
    ]);
    let visits = 0;
    moved.each(() => {
      visits++;
    });
    expect(visits).toBe(0);
  });

  it("visits an entity once, however often it was written", () => {
    const { entities, world } = populated();
    const moved = world.view(Moved);
    moved.entities();
    for (let n = 0; n < 5; n++) {
      world.set(entities[3]!, Position, { x: n });
      world.set(entities[1]!, Position, { x: n });
    }
    world.view(Positions).each((pos, entity) => {
      if (entity === entities[1] || entity === entities[3]) {
        pos.x += 1;
        pos.y += 1;
      }
    });
    // And it is waiting once: what nobody has visited is not noted again.
    expect(world.saveChanges()[0]!.entries).toEqual([3, 1]);
    expect(moved.entities()).toEqual([entities[1], entities[3]]);
    world.set(entities[3]!, Position, { x: 9 });
    expect(moved.entities()).toEqual([entities[3]]);
  });

  it("notices a write by set, by add with a value, and by a setter in each: per row", () => {
    const { entities, world } = populated();
    const moved = world.view(Moved);
    moved.entities();

    world.set(entities[0]!, Position, { x: 1 });
    expect(moved.entities()).toEqual([entities[0]]);

    // Adding a component the entity has, with a value, writes it.
    world.add(entities[4]!, Position.of({ x: 4, y: 4 }));
    expect(moved.entities()).toEqual([entities[4]]);
    // Without a value nothing is written.
    world.add(entities[4]!, Position);
    expect(moved.entities()).toEqual([]);

    world.view(Positions).each((pos) => {
      if (pos.x === 6 || pos.x === 9) {
        pos.y = 1;
      }
    });
    expect(moved.entities()).toEqual([entities[6], entities[9]]);
  });

  it("counts every row that eachChunk hands out of what it writes as written", () => {
    const { entities, world } = populated();
    const hurt = world.view(Hurt);
    const moved = world.view(Moved);
    hurt.entities();
    moved.entities();
    // Raw columns cannot tell: the loop reads, and counts as writing.
    const Healing = Query.all(Health).pipe(Query.writes(Health));
    world.view(Healing).eachChunk((start, end, health) => {
      for (let i = start; i < end; i++) {
        void health.hp[i];
      }
    });
    expect(hurt.entities()).toEqual(entities.slice(0, 5));
    // Only the components the loop was handed to write.
    expect(moved.entities()).toEqual([]);
    world.view(Query.all(Health)).eachChunk(() => {});
    expect(hurt.entities()).toEqual([]);
  });

  it("has no raw loop over a component it watches and writes", () => {
    const { entities, world } = populated();
    const moved = world.view(Moved);
    // Every row handed out would count as written: it would never come to rest.
    void (() =>
      // @ts-expect-error raw columns would count its own visit as a change
      moved.eachChunk(() => {}));
    // A description put together by hand is refused when it runs.
    const byHand = world.view({
      terms: [Position],
      withDefs: [],
      withoutDefs: [],
      changedDefs: [Position],
    });
    expect(() => byHand.eachChunk(() => {})).toThrow(
      /watches "ch\/Position" for changes and also hands it out.*Visit it with each\(\)/
    );
    // The refusal was not a visit.
    expect(byHand.count()).toBe(10);
    // Another component of the same query, which it does not watch, is fine,
    // and so is a query that watches for a component being gained.
    const hurt = world.view(
      Query.all(Position).pipe(Query.changed(Health), Query.writes(Position))
    );
    const born = world.view(Query.all(Health).pipe(Query.added(Health)));
    let rows = 0;
    born.eachChunk((start, end) => {
      rows += end - start;
    });
    hurt.eachChunk((start, end) => {
      rows += end - start;
    });
    expect(rows).toBe(10);
    // To the query that watches Position, the first loop wrote five rows.
    moved.entities();
    hurt.eachChunk(() => {});
    world.set(entities[2]!, Health, { hp: 1 });
    hurt.eachChunk(() => {});
    expect(moved.entities()).toEqual([entities[2]]);
  });

  it("does not take a read for a write", () => {
    const { entities, world } = populated();
    const moved = world.view(Moved);
    moved.entities();
    let sum = 0;
    world.view(Positions).each((pos) => {
      sum += pos.x + pos.y;
    });
    world.get(entities[0]!, Position);
    world.has(entities[0]!, Position);
    world.view(Positions).count();
    world.view(Positions).entities();
    world.hash();
    world.snapshot();
    expect(sum).toBe(45);
    expect(moved.count()).toBe(0);
    expect(moved.entities()).toEqual([]);
  });

  it("counts what it has yet to visit without visiting it", () => {
    const { entities, world } = populated();
    const moved = world.view(Moved);
    expect(moved.count()).toBe(10);
    expect(moved.count()).toBe(10);
    moved.entities();
    expect(moved.count()).toBe(0);
    world.set(entities[1]!, Position, { x: 0 });
    world.set(entities[1]!, Position, { x: 1 });
    world.set(entities[5]!, Position, { x: 0 });
    expect(moved.count()).toBe(2);
    expect(moved.entities()).toEqual([entities[1], entities[5]]);
  });

  it("takes an entity that has just gained the component for a changed one", () => {
    const { entities, world } = populated();
    const hurt = world.view(Hurt);
    hurt.entities();
    world.add(entities[6]!, Health.of({ hp: 3 }));
    const spawned = world.spawn(Health.of({ hp: 1 }));
    expect(hurt.entities()).toEqual([entities[6], spawned]);
  });

  it("leaves out an entity that no longer matches, or no longer exists", () => {
    const { entities, world } = populated();
    const hurt = world.view(Hurt);
    hurt.entities();
    world.set(entities[0]!, Health, { hp: 1 });
    world.set(entities[2]!, Health, { hp: 1 });
    world.set(entities[4]!, Health, { hp: 1 });
    world.remove(entities[0]!, Health);
    world.despawn(entities[2]!);
    expect(hurt.entities()).toEqual([entities[4]]);

    // An entity in the slot of one that was written and despawned was not
    // written: it is visited for having gained the component, and once.
    world.set(entities[4]!, Health, { hp: 2 });
    world.despawn(entities[4]!);
    const reused = world.spawn(Health.of({ hp: 5 }));
    expect(reused & 0x3f_ff_ff).toBe(entities[4]! & 0x3f_ff_ff);
    expect(hurt.entities()).toEqual([reused]);
    const bystander = world.spawn(Position.of({ x: 0, y: 0 }));
    expect(world.isAlive(bystander)).toBe(true);
    expect(hurt.entities()).toEqual([]);
  });

  it("follows an entity that moved to another table after it was written", () => {
    const { entities, world } = populated();
    const moved = world.view(Moved);
    moved.entities();
    world.set(entities[1]!, Position, { x: 100 });
    world.add(entities[1]!, Boss);
    // Removing a row moves the last row of its table into its place.
    world.set(entities[9]!, Position, { x: 900 });
    world.despawn(entities[3]!);
    const seen: number[] = [];
    moved.each((pos) => {
      seen.push(pos.x);
    });
    expect(seen.toSorted((a, b) => a - b)).toEqual([100, 900]);
  });

  it("watches a sparse component, and filters on others", () => {
    const { entities, world } = populated();
    for (const n of [1, 2, 3, 4]) {
      world.add(entities[n]!, Heat.of({ degrees: n }));
    }
    world.add(entities[2]!, Frozen);
    const warmed = world.view(Warmed);
    const thawed = world.view(
      Query.all(Position, Heat).pipe(Query.without(Frozen), Query.changed(Heat))
    );
    expect(warmed.entities()).toEqual([1, 2, 3, 4].map((n) => entities[n]));
    expect(thawed.entities()).toEqual([1, 3, 4].map((n) => entities[n]));

    world.set(entities[2]!, Heat, { degrees: 20 });
    world.set(entities[3]!, Heat, { degrees: 30 });
    world.view(Query.all(Heat).pipe(Query.writes(Heat))).each((heat) => {
      if (heat.degrees === 4) {
        heat.degrees = 40;
      }
    });
    world.add(entities[1]!, Heat.of({ degrees: 10 }));
    world.add(entities[1]!, Heat);
    const seen: number[] = [];
    thawed.each((_, heat) => {
      seen.push(heat.degrees);
    });
    expect(seen).toEqual([10, 30, 40]);
    expect(warmed.entities()).toEqual([1, 2, 3, 4].map((n) => entities[n]));
    // A raw loop over a sparse component counts the rows it is handed.
    world
      .view(
        Query.all(Position, Heat).pipe(
          Query.without(Frozen),
          Query.writes(Heat)
        )
      )
      .eachChunk(() => {});
    expect(warmed.entities()).toEqual([1, 3, 4].map((n) => entities[n]));
  });

  it("visits an entity when any of the components it watches fired", () => {
    const { entities, world } = populated();
    const either = world.view(
      Query.all(Position, Health).pipe(Query.changed(Position, Health))
    );
    const both = world.view(
      Query.all(Position).pipe(Query.changed(Position), Query.added(Boss))
    );
    either.entities();
    both.entities();
    world.set(entities[0]!, Position, { x: 1 });
    world.set(entities[2]!, Health, { hp: 1 });
    world.set(entities[4]!, Position, { x: 1 });
    world.set(entities[4]!, Health, { hp: 1 });
    // Entity 6 has no health, so it does not match however it moves.
    world.set(entities[6]!, Position, { x: 1 });
    expect(either.entities()).toEqual([0, 2, 4].map((n) => entities[n]));
    // Watching Boss requires it.
    expect(both.entities()).toEqual([]);
    world.add(entities[1]!, Boss);
    world.add(entities[4]!, Boss);
    expect(both.entities()).toEqual([entities[1], entities[4]]);
    world.set(entities[4]!, Position, { x: 2 });
    world.set(entities[0]!, Position, { x: 2 });
    expect(both.entities()).toEqual([entities[4]]);
  });

  it("is skipped by a reader that was off, which then sees only what changes after, and holds nothing back for it", () => {
    const { entities, world } = populated(4);
    const off = world.view(Moved, "off");
    const gone = world.removed(Position, "off");
    const on = world.view(Moved, "on");
    off.entities();
    gone.read();
    on.entities();
    world.set(entities[0]!, Position, { x: 1 });
    world.despawn(entities[3]!);
    world.skip("off");
    expect(off.entities()).toEqual([]);
    expect(gone.read()).toEqual([]);
    // Another reader is not skipped with it.
    expect(on.entities()).toEqual([entities[0]]);
    // Nobody is left waiting for what was logged, and it is forgotten.
    expect(world.saveChanges().flatMap((saved) => saved.entries)).toEqual([]);
    world.set(entities[1]!, Position, { x: 2 });
    expect(off.entities()).toEqual([entities[1]]);
    // One that has never visited still visits everything that matches.
    const late = world.view(Moved, "late");
    world.skip("late");
    expect(late.entities()).toEqual(entities.slice(0, 3));
  });

  it("gives each reader its own place, and one place to a reader of two alike queries", () => {
    const { entities, world } = populated();
    const first = world.view(Moved, "first");
    const second = world.view(Moved, "second");
    expect(first).not.toBe(second);
    expect(world.view(Moved, "first")).toBe(first);
    // Another description that says the same is the same query to a reader.
    const alike = Query.all(Position).pipe(
      Query.writes(Position),
      Query.changed(Position)
    );
    expect(world.view(alike, "first")).toBe(first);
    // One that watches something else, or writes something else, is another
    // query, however alike.
    const others: Query.Query<Terms>[] = [
      Query.all(Position).pipe(Query.changed(Position)),
      Query.all(Position).pipe(Query.changed(Health)),
      Query.all(Position).pipe(Query.added(Position)),
      Query.all(Position).pipe(Query.changed(Position), Query.with(Boss)),
      Query.all(Position).pipe(Query.changed(Position), Query.without(Boss)),
      Query.all(Position, Health).pipe(Query.changed(Position)),
    ];
    for (const other of others) {
      expect(world.view(other, "first")).not.toBe(first);
    }
    // And the order a query was put together in does not matter to it.
    const built = [
      Query.all(Position).pipe(
        Query.with(Boss),
        Query.without(Frozen),
        Query.changed(Health),
        Query.added(Heat)
      ),
      Query.all(Position).pipe(
        Query.added(Heat),
        Query.changed(Health),
        Query.without(Frozen),
        Query.with(Boss)
      ),
    ];
    expect(world.view(built[0]!, "first")).toBe(world.view(built[1]!, "first"));
    expect(world.saveChanges()).toEqual([]);
    world.view(built[1]!, "first").entities();
    expect(
      world.saveChanges().map((each) => [each.component, each.kind])
    ).toEqual([
      ["ch/Health", "changed"],
      ["ch/Heat", "added"],
    ]);
    // A query that watches nothing has one view, whoever asks.
    expect(world.view(Positions, "first")).toBe(
      world.view(Positions, "second")
    );

    first.entities();
    second.entities();
    world.set(entities[1]!, Position, { x: 0 });
    expect(first.entities()).toEqual([entities[1]]);
    world.set(entities[2]!, Position, { x: 0 });
    world.set(entities[1]!, Position, { x: 5 });
    expect(first.entities()).toEqual([entities[1], entities[2]]);
    // The second reader has seen none of it, and sees each entity once.
    expect(second.entities()).toEqual([entities[1], entities[2]]);
    expect(second.entities()).toEqual([]);

    // With no reader named, `world.reader` says who is asking.
    world.reader = "first";
    expect(world.view(Moved)).toBe(first);
    world.reader = undefined;
    expect(world.view(Moved)).not.toBe(first);
    expect(world.view(Moved)).toBe(world.view(alike));
  });

  it("sees what it writes itself the next time, and not in the same visit", () => {
    const { entities, world } = populated(4);
    const moved = world.view(Moved);
    let visits = 0;
    moved.each((pos) => {
      visits++;
      pos.x += 1;
    });
    expect(visits).toBe(4);
    moved.each((pos, entity) => {
      visits++;
      if (entity === entities[0]) {
        pos.x += 1;
      }
    });
    expect(visits).toBe(8);
    expect(moved.entities()).toEqual([entities[0]]);
  });

  it("can be nested in itself, each level visiting what is new to it", () => {
    const { entities, world } = populated(3);
    const moved = world.view(Moved);
    moved.entities();
    world.set(entities[0]!, Position, { x: 1 });
    world.set(entities[2]!, Position, { x: 1 });
    const outer: Entity[] = [];
    const inner: Entity[] = [];
    moved.each((pos, entity) => {
      outer.push(entity);
      if (entity === entities[0]) {
        world.set(entities[1]!, Position, { x: 5 });
        moved.each((_, other) => {
          inner.push(other);
        });
      }
      void pos;
    });
    expect(outer).toEqual([entities[0], entities[2]]);
    expect(inner).toEqual([entities[1]]);
    expect(moved.entities()).toEqual([]);
  });

  it("finds its rows the same way by sorting and by marking", () => {
    for (const path of ["sorted", "mask"] as const) {
      const { entities, world } = populated(200);
      // Raw columns of what it watches are not to be had, so it asks for none.
      const moved = world.view(Query.all().pipe(Query.changed(Position)));
      moved._path = path;
      moved.entities();
      const written = [150, 3, 77, 78, 79, 199, 0, 3];
      for (const n of written) {
        world.set(entities[n]!, Position, { y: 1 });
      }
      const chunks: [number, number][] = [];
      const seen: Entity[] = [];
      moved.eachChunk((start, end, ids) => {
        chunks.push([start, end]);
        for (let i = start; i < end; i++) {
          seen.push(ids[i]!);
        }
      });
      expect(moved._lastPath).toBe(path);
      expect(seen).toEqual(
        [0, 3, 77, 78, 79, 150, 199].map((n) => entities[n])
      );
      // Consecutive rows come as one run, in either table.
      expect(chunks.length).toBe(5);
      // And the marks are gone: a later visit starts clean.
      world.set(entities[5]!, Position, { y: 2 });
      expect(moved.entities()).toEqual([entities[5]]);
    }
  });

  it("is not thrown by a watch that starts in the middle of a loop", () => {
    const { entities, world } = populated(6);
    const early: Entity[] = [];
    world.view(Positions).each((pos, entity) => {
      if (entity === entities[2]) {
        // The loop's accessors were made before anything watched Position.
        world.view(Moved).each((_, seen) => {
          early.push(seen);
        });
      }
      pos.x += 1;
    });
    expect(early).toEqual(entities);
    // What the loop wrote after the watch began is not lost.
    const late = world.view(Moved);
    expect(late.entities()).toEqual(entities);
    expect(late.entities()).toEqual([]);
    world.view(Positions).each((pos) => {
      pos.x += 1;
    });
    expect(late.entities()).toEqual(entities);
  });

  it("costs nothing to components nobody watches", () => {
    const { entities, world } = populated();
    world.view(Hurt).entities();
    // Position is not watched: its writes are noted nowhere.
    world.set(entities[0]!, Position, { x: 1 });
    world.view(Positions).each((pos) => {
      pos.x += 1;
    });
    expect(
      world.saveChanges().map((each) => [each.component, each.entries])
    ).toEqual([["ch/Health", []]]);
  });
});

describe("added and removed", () => {
  it("visits what gained a component: spawned with it or added, not written", () => {
    const { entities, world } = populated();
    const first = world.spawn(Sprite.of({ frame: 1 }));
    const born = world.view(Born);
    expect(born.entities()).toEqual([first]);

    world.add(entities[3]!, Sprite.of({ frame: 2 }));
    const second = world.spawn(Position.of({ x: 0, y: 0 }), Sprite);
    world.set(first, Sprite, { frame: 9 });
    // Adding what an entity has is not gaining it.
    world.add(first, Sprite.of({ frame: 8 }));
    const seen: number[] = [];
    born.each((sprite) => {
      seen.push(sprite.frame);
    });
    expect(seen).toEqual([2, 0]);
    expect(born.entities()).toEqual([]);

    // Lost and gained again is gained.
    world.remove(second, Sprite);
    world.add(second, Sprite);
    expect(born.entities()).toEqual([second]);
    // Gained and lost again is not there to visit.
    world.add(entities[5]!, Sprite);
    world.remove(entities[5]!, Sprite);
    expect(born.entities()).toEqual([]);
  });

  it("reports what lost a component, by remove or despawn, once per removal", () => {
    const { entities, world } = populated();
    world.add(entities[1]!, Heat.of({ degrees: 1 }));
    world.add(entities[2]!, Heat.of({ degrees: 2 }));
    const lostHealth = world.removed(Health);
    const lostHeat = world.removed(Heat);
    expect(lostHealth.read()).toEqual([]);

    world.remove(entities[0]!, Health);
    // Not there to lose.
    world.remove(entities[6]!, Health);
    world.remove(entities[0]!, Health);
    world.despawn(entities[2]!);
    world.despawn(entities[7]!);
    expect(lostHealth.read()).toEqual([entities[0], entities[2]]);
    expect(lostHealth.read()).toEqual([]);
    expect(lostHeat.read()).toEqual([entities[2]]);
    expect(world.isAlive(entities[0]!)).toBe(true);
    expect(world.isAlive(entities[2]!)).toBe(false);

    world.remove(entities[1]!, Heat);
    world.add(entities[1]!, Heat);
    world.remove(entities[1]!, Heat);
    expect(lostHeat.read()).toEqual([entities[1], entities[1]]);
  });

  it("gives each reader of removals its own place", () => {
    const { entities, world } = populated();
    const first = world.removed(Health, "first");
    world.remove(entities[0]!, Health);
    // A reader that asks later has missed nothing it could have seen.
    const second = world.removed(Health, "second");
    expect(world.removed(Health, "first")).toBe(first);
    world.remove(entities[2]!, Health);
    expect(second.read()).toEqual([entities[2]]);
    expect(first.read()).toEqual([entities[0], entities[2]]);
    world.reader = "second";
    expect(world.removed(Health)).toBe(second);
    world.reader = undefined;
    expect(world.removed(Health)).not.toBe(second);
  });
});

/** A raw loop that is handed positions to read and health to write. */
const RawReader = Query.all(Position, Health).pipe(
  Query.writes(Health),
  Query.without(Frozen)
);

describe("changes against a simple model", () => {
  // Every reader is checked against a set of entities kept by hand: what
  // was written since it last visited, narrowed to what matches now, in
  // the order a plain query visits them.
  const specs: {
    query: Query.Query<Terms>;
    plain: Query.Query<Terms>;
    fires: string[];
    raw: boolean;
  }[] = [
    {
      query: Query.all(Position).pipe(Query.changed(Position)),
      plain: Query.all(Position),
      fires: ["Position:changed"],
      // Whether it can be visited with eachChunk: it writes nothing it watches.
      raw: true,
    },
    {
      query: Query.all(Position, Health).pipe(
        Query.changed(Health),
        Query.writes(Health)
      ),
      plain: Query.all(Position, Health),
      fires: ["Health:changed"],
      raw: false,
    },
    {
      query: Query.all(Health).pipe(
        Query.without(Frozen),
        Query.changed(Position, Health)
      ),
      plain: Query.all(Health, Position).pipe(Query.without(Frozen)),
      fires: ["Position:changed", "Health:changed"],
      raw: true,
    },
    {
      query: Query.all(Position).pipe(
        Query.added(Heat),
        Query.writes(Position)
      ),
      plain: Query.all(Position, Heat),
      fires: ["Heat:added"],
      raw: true,
    },
    {
      query: Query.all(Heat).pipe(
        Query.with(Frozen),
        Query.changed(Heat),
        Query.writes(Heat)
      ),
      plain: Query.all(Heat).pipe(Query.with(Frozen)),
      fires: ["Heat:changed"],
      raw: false,
    },
    {
      query: Query.all(Position).pipe(
        Query.changed(Heat),
        Query.added(Health),
        Query.writes(Position)
      ),
      plain: Query.all(Position, Heat, Health),
      fires: ["Heat:changed", "Health:added"],
      raw: true,
    },
    {
      // Hands out what it watches, which it only reads.
      query: Query.all(Position, Health).pipe(
        Query.changed(Position),
        Query.writes(Health)
      ),
      plain: Query.all(Position, Health),
      fires: ["Position:changed"],
      raw: true,
    },
  ];

  for (const seed of [1, 2, 3, 4]) {
    it(`agrees with it through thousands of random operations (seed ${seed})`, () => {
      const dice = new EcsWorld({ seed }).random;
      const world = new EcsWorld();
      const alive: Entity[] = [];
      // Two readers per query, which visit at different times.
      const readers = specs.flatMap((spec, s) =>
        [0, 1].map((r) => ({
          spec,
          label: `reader ${s}.${r}`,
          view: world.view(spec.query, `reader ${s}.${r}`),
          pending: new Set<Entity>(),
          fresh: true,
          lazy: r === 1,
        }))
      );
      const lost = { reader: world.removed(Health), expected: [] as Entity[] };
      const checks = makeChecks();
      const fire = (what: string, entity: Entity): void => {
        for (const reader of readers) {
          if (reader.spec.fires.includes(what)) {
            reader.pending.add(entity);
          }
        }
      };
      const defs = { Position, Health, Heat } as const;
      const value = (name: keyof typeof defs) =>
        name === "Position"
          ? Position.of({ x: dice.int(0, 99), y: 0 })
          : name === "Health"
            ? Health.of({ hp: dice.int(1, 99) })
            : Heat.of({ degrees: dice.int(1, 99) });
      const gained = (name: keyof typeof defs, entity: Entity): void => {
        fire(`${name}:added`, entity);
        fire(`${name}:changed`, entity);
      };

      for (let step = 0; step < 3000; step++) {
        const roll = dice.int(0, 19);
        const some = alive.length > 0 ? dice.pick(alive) : undefined;
        if (roll < 3 || some === undefined) {
          const names = (["Position", "Health", "Heat"] as const).filter(
            () => dice.next() < 0.6
          );
          const entity = world.spawn(...names.map((name) => value(name)));
          alive.push(entity);
          for (const name of names) {
            gained(name, entity);
          }
        } else if (roll < 5) {
          if (world.has(some, Health)) {
            lost.expected.push(some);
          }
          world.despawn(some);
          alive.splice(alive.indexOf(some), 1);
          for (const reader of readers) {
            reader.pending.delete(some);
          }
        } else if (roll < 8) {
          const name = dice.pick(["Position", "Health", "Heat"] as const);
          const had = world.has(some, defs[name]);
          const bare = dice.next() < 0.3;
          world.add(some, bare ? defs[name] : value(name));
          if (!had) {
            gained(name, some);
          } else if (!bare) {
            fire(`${name}:changed`, some);
          }
        } else if (roll < 10) {
          const name = dice.pick(["Position", "Health", "Heat"] as const);
          if (name === "Health" && world.has(some, Health)) {
            lost.expected.push(some);
          }
          world.remove(some, defs[name]);
        } else if (roll < 11) {
          if (world.has(some, Frozen)) {
            world.remove(some, Frozen);
          } else {
            world.add(some, Frozen);
          }
        } else if (roll < 14) {
          const name = dice.pick(["Position", "Health", "Heat"] as const);
          if (world.has(some, defs[name])) {
            world.set(
              some,
              defs[name] as typeof Position,
              (value(name) as { value: { x: number; y: number } }).value
            );
            fire(`${name}:changed`, some);
          }
        } else if (roll < 16) {
          // A loop that writes some of the rows it visits.
          const modulus = dice.int(2, 5);
          const Healing = Query.all(Health).pipe(Query.writes(Health));
          world.view(Healing).each((health, entity) => {
            if (entity % modulus === 0) {
              health.hp += 1;
              fire("Health:changed", entity);
            }
          });
          world
            .view(
              Query.all(Heat, Position).pipe(
                Query.without(Frozen),
                Query.writes(Heat, Position)
              )
            )
            .each((heat, pos, entity) => {
              if (entity % modulus === 1) {
                heat.degrees += 1;
                fire("Heat:changed", entity);
              } else if (entity % modulus === 0) {
                pos.y += 1;
                fire("Position:changed", entity);
              }
            });
        } else if (roll < 17) {
          // A raw loop: every row it is handed to write counts.
          world
            .view(
              Query.all(Position).pipe(
                Query.with(Frozen),
                Query.writes(Position)
              )
            )
            .eachChunk((start, end, _, ids) => {
              for (let i = start; i < end; i++) {
                fire("Position:changed", ids[i]!);
              }
            });
          // And none it only reads.
          world.view(RawReader).eachChunk((start, end, _, __, ids) => {
            for (let i = start; i < end; i++) {
              fire("Health:changed", ids[i]!);
            }
          });
        } else {
          for (const reader of readers) {
            if (dice.next() < (reader.lazy ? 0.05 : 0.5)) {
              reader.view._path = dice.pick(["auto", "sorted", "mask"]);
              const matching = world.view(reader.spec.plain).entities();
              const expected = reader.fresh
                ? matching
                : matching.filter((entity) => reader.pending.has(entity));
              if (dice.next() < 0.3) {
                checks.check(
                  `step ${step}: ${reader.label} counts`,
                  reader.view.count(),
                  expected.length
                );
              }
              const seen: Entity[] = [];
              // Before the visit: what the visit itself fires is for later.
              reader.pending.clear();
              if (!reader.spec.raw || dice.next() < 0.5) {
                reader.view.each((...args) => {
                  seen.push(args.at(-1) as Entity);
                });
              } else {
                reader.view.eachChunk((start, end, ...args) => {
                  const ids = args.at(-1) as EntityColumn;
                  for (let i = start; i < end; i++) {
                    seen.push(ids[i]!);
                  }
                });
                // The raw loop was handed the rows it visited: to every
                // reader that watches one of its terms, they were written,
                // but for the terms it said it only reads.
                for (const entity of seen) {
                  for (const def of reader.spec.query.terms) {
                    if (!reader.spec.query.readDefs.includes(def)) {
                      fire(`${def.name.slice(3)}:changed`, entity);
                    }
                  }
                }
              }
              checks.check(
                `step ${step}: ${reader.label} visits`,
                seen,
                expected
              );
              reader.fresh = false;
            }
          }
          if (dice.next() < 0.3) {
            checks.check(
              `step ${step}: what lost Health`,
              lost.reader.read(),
              lost.expected
            );
            lost.expected = [];
          }
        }
      }
      expectChecked(checks, 1000);
    });
  }
});

describe("a change log", () => {
  it("does not outgrow the world while a reader stays away", () => {
    const { entities, world } = populated(50);
    const busy = world.view(Moved, "busy");
    const away = world.view(Moved, "away");
    const sometimes = world.view(Moved, "sometimes");
    busy.entities();
    away.entities();
    sometimes.entities();
    const expected = new Set<Entity>();
    const lately = new Set<Entity>();
    const checks = makeChecks();
    let longest = 0;
    // Ten entities are written once, long before the readers that stay
    // away come back, and the other forty over and over.
    for (let n = 40; n < 50; n++) {
      world.set(entities[n]!, Position, { x: -1 });
      expected.add(entities[n]!);
      lately.add(entities[n]!);
    }
    for (let round = 0; round < 3000; round++) {
      // The busy reader visits every round, so each round logs afresh.
      for (let n = round % 7; n < 40; n += 7) {
        world.set(entities[n]!, Position, { x: round });
        expected.add(entities[n]!);
        lately.add(entities[n]!);
      }
      expect(busy.count()).toBeGreaterThan(0);
      busy.entities();
      if (round % 331 === 5 || round % 331 === 6) {
        // A reader part of the way along sees what is new to it, no more.
        checks.check(
          `round ${round}`,
          sometimes.entities(),
          entities.filter((entity) => lately.has(entity))
        );
        lately.clear();
      }
      longest = Math.max(longest, world.saveChanges()[0]!.entries.length);
    }
    expectChecked(checks, 18);
    // Some 17,000 writes were logged, of 50 entities.
    expect(longest).toBeLessThan(2100);
    expect(expected.size).toBe(50);
    expect(away.count()).toBe(expected.size);
    expect(away.entities()).toEqual(
      entities.filter((entity) => expected.has(entity))
    );
    sometimes.entities();
    expect(world.saveChanges()[0]!.entries).toEqual([]);
    world.set(entities[0]!, Position, { x: -1 });
    expect(busy.entities()).toEqual([entities[0]]);
    expect(away.entities()).toEqual([entities[0]]);
    expect(sometimes.entities()).toEqual([entities[0]]);
  });

  it("keeps up with a world that grows past the room it was made with", () => {
    const { entities, world } = populated(10);
    const moved = world.view(Moved);
    const lost = world.removed(Position);
    moved.entities();
    for (let n = 0; n < 5000; n++) {
      entities.push(world.spawn(Position.of({ x: n, y: 0 })));
    }
    expect(moved.count()).toBe(5000);
    expect(moved.entities()).toEqual(entities.slice(10));
    for (let pass = 0; pass < 3; pass++) {
      world.view(Positions).each((pos) => {
        pos.x += 1;
      });
    }
    expect(moved.count()).toBe(5010);
    // Each is waiting once, the ones past the first room too.
    expect(world.saveChanges()[0]!.entries.length).toBe(5010);
    moved.entities();
    world.view(Positions).each((pos, entity) => {
      if (entity % 1000 === 7) {
        pos.x = 0;
      }
    });
    world.set(entities[4500]!, Position, { y: 1 });
    expect(moved.entities()).toEqual(
      entities.filter((entity, n) => entity % 1000 === 7 || n === 4500)
    );
    for (const entity of entities.slice(3000)) {
      world.despawn(entity);
    }
    expect(lost.read()).toEqual(entities.slice(3000));
    expect(moved.count()).toBe(0);
  });

  it("forgets what every reader has visited", () => {
    const { entities, world } = populated();
    const first = world.view(Moved, "first");
    const second = world.view(Moved, "second");
    first.entities();
    second.entities();
    world.set(entities[1]!, Position, { x: 0 });
    world.set(entities[2]!, Position, { x: 0 });
    first.entities();
    world.set(entities[3]!, Position, { x: 0 });
    expect(world.saveChanges()).toEqual([
      {
        component: "ch/Position",
        kind: "changed",
        entries: [1, 2, 3],
        readers: {
          [`first\n${MOVED}`]: 2,
          [`second\n${MOVED}`]: 0,
        },
      },
    ]);
    second.entities();
    expect(world.saveChanges()[0]!.entries).toEqual([3]);
    first.entities();
    expect(world.saveChanges()[0]!.entries).toEqual([]);
  });
});

describe("changes in a transaction", () => {
  it("are forgotten on rollback, and kept on commit", () => {
    const { entities, world } = populated();
    const moved = world.view(Moved);
    const hurt = world.view(Hurt);
    moved.entities();
    hurt.entities();
    world.set(entities[8]!, Position, { x: 8 });

    world.begin();
    world.set(entities[1]!, Position, { x: 1 });
    world.set(entities[8]!, Position, { x: 9 });
    world.view(Positions).each((pos) => {
      pos.y += 1;
    });
    world
      .view(Query.all(Health).pipe(Query.writes(Health)))
      .eachChunk(() => {});
    expect(moved.count()).toBe(10);
    world.rollback();
    // What was written before the transaction is still there to visit.
    expect(hurt.entities()).toEqual([]);
    expect(moved.entities()).toEqual([entities[8]]);

    world.begin();
    world.set(entities[1]!, Position, { x: 1 });
    world.commit();
    expect(moved.entities()).toEqual([entities[1]]);

    // An entity noted in a transaction that was rolled back is noted again.
    world.begin();
    world.set(entities[2]!, Position, { x: 2 });
    world.rollback();
    world.set(entities[2]!, Position, { x: 3 });
    expect(moved.entities()).toEqual([entities[2]]);
  });

  it("puts a reader back where it was on rollback", () => {
    const { entities, world } = populated();
    const moved = world.view(Moved);
    const lost = world.removed(Health);
    moved.entities();
    world.set(entities[4]!, Position, { x: 4 });
    world.remove(entities[4]!, Health);

    world.begin();
    expect(moved.entities()).toEqual([entities[4]]);
    expect(lost.read()).toEqual([entities[4]]);
    world.set(entities[5]!, Position, { x: 5 });
    expect(moved.entities()).toEqual([entities[5]]);
    world.rollback();
    // The visits of a refused action never happened.
    expect(moved.entities()).toEqual([entities[4]]);
    expect(lost.read()).toEqual([entities[4]]);

    world.set(entities[6]!, Position, { x: 6 });
    world.begin();
    expect(moved.entities()).toEqual([entities[6]]);
    // Written again after the visit: that is news, in the transaction and
    // after it.
    world.set(entities[6]!, Position, { x: 7 });
    world.commit();
    expect(moved.entities()).toEqual([entities[6]]);
    expect(moved.entities()).toEqual([]);
    world.set(entities[7]!, Position, { x: 6 });
    world.begin();
    expect(moved.entities()).toEqual([entities[7]]);
    world.set(entities[7]!, Position, { x: 7 });
    world.set(entities[8]!, Position, { x: 7 });
    world.rollback();
    world.set(entities[8]!, Position, { x: 8 });
    expect(moved.entities()).toEqual([entities[7], entities[8]]);

    // A visit in a transaction, after a write in it, went further than the
    // log goes once both are taken back. What is written afterwards is
    // news all the same, however often.
    world.begin();
    world.set(entities[1]!, Position, { x: 1 });
    world.set(entities[2]!, Position, { x: 1 });
    expect(moved.entities()).toEqual([entities[1], entities[2]]);
    world.rollback();
    for (let round = 0; round < 3; round++) {
      world.set(entities[3]!, Position, { x: round });
      expect(moved.entities()).toEqual([entities[3]]);
    }

    // A query that first runs in a transaction that is rolled back has
    // still never run.
    const hurt = world.view(Hurt);
    world.begin();
    expect(hurt.count()).toBe(4);
    hurt.entities();
    expect(hurt.count()).toBe(0);
    world.rollback();
    expect(hurt.count()).toBe(4);
  });
});

describe("changes and a snapshot", () => {
  it("are saved beside it, and a reader goes on from where it was", () => {
    const { entities, world } = populated();
    const moved = world.view(Moved, "mover");
    const lost = world.removed(Health, "mourner");
    world.view(Born, "never ran");
    moved.entities();
    world.set(entities[2]!, Position, { x: 20 });
    world.set(entities[6]!, Position, { x: 60 });
    world.remove(entities[4]!, Health);
    const before = world.hash();
    const saved = world.saveChanges();
    // Plain data, in order of name.
    expect(JSON.parse(JSON.stringify(saved))).toEqual(saved);
    expect(saved.map((each) => `${each.component} ${each.kind}`)).toEqual([
      "ch/Health removed",
      "ch/Position changed",
    ]);
    // Nothing of it is in the hash or in the snapshot.
    expect(world.hash()).toBe(before);

    const copy = new EcsWorld();
    copy.load(world.snapshot(), [Position, Health, Sprite]);
    copy.restoreChanges(saved);
    expect(copy.hash()).toBe(before);
    // Watched from the moment it is loaded, before any reader asks.
    copy.set(entities[1]!, Position, { x: 10 });
    expect(copy.view(Moved, "mover").entities()).toEqual(
      [1, 2, 6].map((n) => entities[n])
    );
    expect(copy.removed(Health, "mourner").read()).toEqual([entities[4]]);
    // A reader the save does not know starts from everything.
    expect(copy.view(Moved, "newcomer").entities()).toEqual(
      copy.view(Positions).entities()
    );
    expect(copy.view(Born, "never ran").count()).toBe(0);
    // And the original goes on the same.
    world.set(entities[1]!, Position, { x: 10 });
    expect(moved.entities()).toEqual([1, 2, 6].map((n) => entities[n]));
    expect(lost.read()).toEqual([entities[4]]);
  });

  it("can leave readers out of a save", () => {
    const { entities, world } = populated();
    world.view(Moved, "kept").entities();
    world.view(Moved, "frame:left out").entities();
    world.set(entities[2]!, Position, { x: 20 });
    world.view(Moved, "kept").entities();
    world.set(entities[3]!, Position, { x: 30 });
    const saved = world.saveChanges((reader) => !reader.startsWith("frame:"));
    expect(saved).toEqual([
      {
        component: "ch/Position",
        kind: "changed",
        entries: [3],
        readers: {
          [`kept\n${MOVED}`]: 0,
        },
      },
    ]);
    expect(world.saveChanges((reader) => reader === "nobody at all")).toEqual(
      []
    );
  });

  it("refuses changes that do not fit the world, and a world already watched", () => {
    const { world } = populated(3);
    const bytes = world.snapshot();
    const restore = (entries: number[], readers: Record<string, number>) => {
      const copy = new EcsWorld();
      copy.load(bytes, [Position, Health]);
      copy.restoreChanges([
        { component: "ch/Position", kind: "changed", entries, readers },
      ]);
      return copy;
    };
    expect(() => restore([0, 3], {})).toThrow(/name an entity that cannot be/);
    expect(() => restore([0, 1.5], {})).toThrow(/cannot be/);
    expect(() => restore([0, 1], { reader: 3 })).toThrow(
      /further than they go/
    );
    const copy = restore([0, 2], { [`reader\n${MOVED}`]: 1 });
    expect(copy.view(Moved, "reader").entities()).toEqual([2]);
    expect(() => copy.restoreChanges([])).toThrow(/already being watched/);
    // A component the world does not know is left out.
    const other = new EcsWorld();
    other.load(bytes, [Position, Health]);
    other.restoreChanges([
      { component: "ch/Gone", kind: "changed", entries: [9], readers: {} },
    ]);
    expect(other.saveChanges()).toEqual([]);
  });
});

// --- in an app --------------------------------------------------------------------

const Tally = Component.define("ch/Tally", {
  moved: Field.u32,
  hurt: Field.u32,
  born: Field.u32,
  gone: Field.u32,
  early: Field.u32,
});
const Tallies = Query.all(Tally).pipe(Query.writes(Tally));
/** The tallies, read from outside the game. */
const Tallied = Query.all(Tally);
const tallyOf = (app: Pick<App.Any, "read">) => {
  let out: Record<string, number> = {};
  Effect.runSync(app.read(Tallied)).each((tally) => {
    out = {
      moved: tally.moved,
      hurt: tally.hurt,
      born: tally.born,
      gone: tally.gone,
      early: tally.early,
    };
  });
  return out;
};

const Push = Action.define(
  "ch/Push",
  Schema.Struct({ slot: Schema.Int, refuse: Schema.Boolean })
);
const Spawn = Action.define("ch/Spawn", Schema.Struct({}));
const Cull = Action.define("ch/Cull", Schema.Struct({ slot: Schema.Int }));
class Refused extends Data.TaggedError("Refused")<{}> {}

const push = Action.handler(Push, function* ({ refuse, slot }) {
  let n = 0;
  (yield* Positions).each((pos) => {
    if (n++ === slot) {
      pos.x += 1;
    }
  });
  if (refuse) {
    return yield* new Refused();
  }
});
const spawn = Action.handler(Spawn, function* () {
  (yield* Commands.spawns(Position, Sprite)).spawn(
    Position.of({ x: 0, y: 0 }),
    Sprite
  );
});
const cull = Action.handler(Cull, function* ({ slot }) {
  const all = (yield* Positions).entities();
  if (all[slot] !== undefined) {
    (yield* Commands).despawn(all[slot]);
  }
});

/** Runs before the system that writes, so it sees those writes a tick late. */
const Early = System.tick("Early", function* () {
  const moved = (yield* Moved).count();
  (yield* Moved).entities();
  (yield* Tallies).each((tally) => {
    tally.early += moved;
  });
});
const Drift = System.tick("Drift", function* () {
  const { tick } = yield* Time;
  (yield* Positions).each((pos, entity) => {
    if ((entity + tick) % 3 === 0) {
      pos.y += 1;
    }
  });
});
const Count = System.tick("Count", function* () {
  let moved = 0;
  (yield* Moved).each(() => {
    moved++;
  });
  let born = 0;
  (yield* Born).each(() => {
    born++;
  });
  const gone = (yield* Query.removed(Position)).read().length;
  (yield* Tallies).each((tally) => {
    tally.moved += moved;
    tally.born += born;
    tally.gone += gone;
  });
});

/** How the game begins: its tally, and six entities with a position. */
const Begin = Plugin.make("ch/Begin", {
  setup: Effect.map(Commands.spawns(Tally, Position), (commands) => {
    commands.spawn(Tally);
    for (let n = 0; n < 6; n++) {
      commands.spawn(Position.of({ x: n, y: 0 }));
    }
  }),
});
const Game = App.define(
  // @ts-expect-error a watcher listed ahead of what it watches, on purpose
  {
    plugins: [Begin],
    systems: [Early, Drift, Count],
    handlers: [push, spawn, cull],
  }
);

const game = (
  options: { checkpointEvery?: number } = {}
): Effect.Effect<
  App.App<never, typeof push | typeof spawn | typeof cull>,
  never
> => App.make(Game, { checkpointEvery: options.checkpointEvery ?? 1 });

/** A game with a move every tick, some of them refused. */
const play = (app: App.Any, from: number, to: number): void => {
  for (let tick = from; tick < to; tick++) {
    app.dispatchByName("ch/Push", { slot: tick % 5, refuse: tick % 3 === 1 });
    if (tick % 4 === 0) {
      app.enqueueByName("ch/Spawn", {});
    }
    if (tick % 7 === 3) {
      app.enqueueByName("ch/Cull", { slot: 1 });
    }
    app.tick(1);
  }
};

describe("change queries in an app", () => {
  it("give every system its own place: the same changes, each once", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const app = yield* game();
        app.tick(1);
        // Tick 1: entities 2 and 5 drift (ids 1..6, tick 1). Count runs
        // for the first time and sees all six; Early saw six too.
        expect(tallyOf(app)).toMatchObject({ moved: 6, early: 6, born: 0 });
        app.tick(1);
        // Tick 2: Early sees the two that drifted in tick 1, a tick late;
        // Count sees the two that drift in tick 2.
        expect(tallyOf(app)).toMatchObject({ moved: 8, early: 8 });
        app.dispatch(Push, { slot: 0, refuse: false });
        app.dispatch(Spawn, {});
        app.tick(1);
        // Early: the two that drifted in tick 2, one of which was also
        // pushed, and the one that was spawned. Count: the pushed one, the
        // spawned one, and the two that drift in tick 3.
        expect(tallyOf(app)).toMatchObject({ early: 11, moved: 12, born: 1 });
      })
    );
  });

  it("do not show a refused action's writes to anyone", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const One = Plugin.make("ch/One", {
          setup: Effect.map(Commands.spawns(Tally, Position), (commands) => {
            commands.spawn(Tally);
            commands.spawn(Position.of({ x: 0, y: 0 }));
          }),
        });
        const quiet = yield* App.make(
          App.define({ plugins: [One], systems: [Count], handlers: [push] })
        );
        quiet.tick(1);
        expect(tallyOf(quiet).moved).toBe(1);
        expect(
          Exit.isFailure(quiet.dispatch(Push, { slot: 0, refuse: true }))
        ).toBe(true);
        quiet.tick(1);
        expect(tallyOf(quiet).moved).toBe(1);
        quiet.dispatch(Push, { slot: 0, refuse: false });
        quiet.tick(1);
        expect(tallyOf(quiet).moved).toBe(2);
      })
    );
  });

  it("give a handler a place of its own, apart from the systems'", () => {
    const Inspect = Action.define("ch/Inspect", Schema.Struct({}));
    const inspect = Action.handler(Inspect, function* () {
      return (yield* Moved).entities().length;
    });
    Effect.runSync(
      Effect.gen(function* () {
        const watched: number[] = [];
        const Watch = System.tick("Watch", function* () {
          watched.push((yield* Moved).entities().length);
        });
        const Three = Plugin.make("ch/Three", {
          setup: Effect.map(Commands.spawns(Position), (commands) => {
            for (let n = 0; n < 3; n++) {
              commands.spawn(Position.of({ x: n, y: 0 }));
            }
          }),
        });
        const app = yield* App.make(
          App.define({
            plugins: [Three],
            systems: [Watch],
            handlers: [inspect, push],
          })
        );
        expect(app.dispatch(Inspect, {})).toEqual(Exit.succeed(3));
        expect(app.dispatch(Inspect, {})).toEqual(Exit.succeed(0));
        app.dispatch(Push, { slot: 1, refuse: false });
        app.tick(1);
        expect(app.dispatch(Inspect, {})).toEqual(Exit.succeed(1));
        app.tick(1);
        // Each reads from its own place.
        expect(watched).toEqual([3, 0]);
      })
    );
  });

  it("replay, with refused actions among them, checkpoint by checkpoint", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const app = yield* game();
        play(app, 0, 40);
        expect(tallyOf(app).moved).toBeGreaterThan(40);
        expect(tallyOf(app).gone).toBeGreaterThan(2);
        const played = app.record();
        const again = yield* Journal.replay(played, Game, {
          checkpointEvery: 1,
        });
        expect((yield* again.read(World)).hash()).toBe(
          (yield* app.read(World)).hash()
        );
        expect(tallyOf(again)).toEqual(tallyOf(app));
      })
    );
  });

  it("are saved with a game: loaded, each system goes on from where it was", () => {
    for (const savedAt of [0, 1, 2, 9, 23]) {
      Effect.runSync(
        Effect.gen(function* () {
          const app = yield* game();
          play(app, 0, savedAt);
          // Between ticks, with changes waiting for both systems.
          app.dispatchByName("ch/Push", { slot: 2, refuse: false });
          const save = app.save();
          if (Exit.isFailure(save)) {
            throw new Error("the save was refused");
          }
          const bytes = Save.encode(save.value);
          const read = Save.decode(bytes);
          if (Exit.isFailure(read)) {
            throw new Error("the save did not decode");
          }
          expect(read.value).toEqual(save.value);
          // Once a tick has run, there is a place to go on from.
          expect(visitsIn(save.value).length > 0).toBe(savedAt > 0);
          play(app, savedAt, savedAt + 12);
          // The tail of the original's log replays in a game loaded from the
          // save that was read, and every checkpoint of it holds.
          const played = app.record(read.value);
          const loaded = yield* Journal.replay(played, Game, {
            checkpointEvery: 1,
          });
          expect(tallyOf(loaded)).toEqual(tallyOf(app));
          expect((yield* loaded.read(World)).hash()).toBe(
            (yield* app.read(World)).hash()
          );
        })
      );
    }
  });

  it("go on, under its new name, for a component a migration renamed", () => {
    const Place = Component.define("ch/Place", { x: Field.f32, y: Field.f32 });
    const Placed = Query.all(Place).pipe(
      Query.changed(Place),
      Query.writes(Place)
    );
    const Arrived = Query.all(Position).pipe(Query.added(Position));
    const Landed = Query.all(Place).pipe(Query.added(Place));
    const Look = Action.define("ch/Look", Schema.Struct({}));
    const before = Action.handler(Look, function* () {
      const counts = [
        (yield* Moved).count(),
        (yield* Hurt).count(),
        (yield* Arrived).count(),
      ];
      // Counting is not visiting: these are.
      (yield* Moved).entities();
      (yield* Hurt).entities();
      (yield* Arrived).entities();
      return counts;
    });
    const after = Action.handler(Look, function* () {
      return [
        (yield* Placed).count(),
        (yield* Hurt).count(),
        (yield* Landed).count(),
      ];
    });
    const Hit = Action.define("ch/Hit", Schema.Struct({ entity: EntityId }));
    const hit = Action.handler(Hit, function* ({ entity }) {
      const world = yield* World.writes(Health, Position);
      world.set(entity, Health, { hp: 9 });
      world.set(entity, Position, { x: 9 });
    });
    const made: Spawned[] = [];
    const Four = Plugin.make("ch/Four", {
      setup: Effect.map(Commands.spawns(Position, Health), (commands) => {
        for (let n = 0; n < 4; n++) {
          made.push(
            commands.spawn(Position.of({ x: n, y: 0 }), Health.of({ hp: n }))
          );
        }
      }),
    });
    Effect.runSync(
      Effect.gen(function* () {
        const app = yield* App.make(
          App.define({ plugins: [Four], handlers: [before, hit] })
        );
        const [, second] = made;
        assert(second !== undefined);
        expect(app.dispatch(Look, {})).toEqual(Exit.succeed([4, 4, 4]));
        app.dispatch(Hit, { entity: placedIn(yield* app.read(World), second) });
        const save = app.save();
        if (Exit.isFailure(save)) {
          throw new Error("the save was refused");
        }
        const loaded = yield* App.make(
          App.define({
            handlers: [after],
            version: 1,
            migrations: [
              {
                from: 0,
                migrate: (contents) => {
                  Migrate.renameComponent(
                    contents.world,
                    "ch/Position",
                    "ch/Place"
                  );
                  expect(
                    visitsOf(contents.world).map((each) => each.component)
                  ).toEqual(["ch/Health", "ch/Place", "ch/Place"]);
                },
              },
            ],
          }),
          { save: save.value }
        );
        // Only the entity hit since the last look counts as changed, and
        // none as added.
        expect(loaded.dispatch(Look, {})).toEqual(Exit.succeed([1, 1, 0]));
      })
    );
  });

  it("make a load fail, with the reason, when the changes of a save are damaged", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const app = yield* game();
        play(app, 0, 3);
        const save = app.save();
        if (Exit.isFailure(save)) {
          throw new Error("the save was refused");
        }
        /** The save, with what its change queries had yet to visit replaced. */
        const withVisits = (visits: unknown): Save.Save => {
          const world = readSnapshot(save.value.world);
          world.stores = [{ name: Save.VISITS, data: visits }];
          return { ...save.value, world: writeSnapshot(world) };
        };
        const damaged = withVisits([
          {
            component: "ch/Position",
            kind: "changed",
            entries: [4_000_000],
            readers: {},
          },
        ]);
        const exit = yield* Effect.exit(
          App.make(App.define({}), { save: damaged })
        );
        expect(
          Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        ).toMatchObject({
          _tag: "LoadRefused",
          problem: "corrupt",
          message: expect.stringContaining(
            'the changes it holds for "ch/Position" name an entity that cannot be'
          ),
        });
        // And changes that are not of the right shape are not loaded either.
        const misshapen = yield* Effect.exit(
          App.make(App.define({}), { save: withVisits([{ component: 1 }]) })
        );
        expect(
          Exit.isFailure(misshapen) ? Cause.squash(misshapen.cause) : undefined
        ).toMatchObject({ _tag: "LoadRefused", problem: "corrupt" });
      })
    );
  });
});
