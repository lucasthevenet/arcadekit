import { Effect, Exit, Schema } from "effect";
import type { Scope } from "effect";
import { assert, describe, expect, it } from "vitest";

import {
  Action,
  App,
  CommandBuffer,
  Commands,
  Component,
  EcsWorld,
  EntityId,
  Field,
  Journal,
  Plugin,
  Query,
  Save,
  SnapshotError,
  System,
  World,
  readSnapshot,
  writeSnapshot,
} from "../src/index";
import type { Entity, RelationDef } from "../src/index";

const Body = Component.define("rl/Body", { x: Field.f32 });
/** A child goes with its parent. */
const ChildOf = Component.relation("rl/ChildOf", {
  onTargetDespawn: "despawn",
});
/** Whoever aims at something that is gone aims at nothing. */
const Targets = Component.relation("rl/Targets", {
  onTargetDespawn: "remove",
  storage: "sparse",
});
/** A relation with data of its own, in a table. */
const Owes = Component.relation("rl/Owes", {
  onTargetDespawn: "remove",
  fields: { amount: Field.i32 },
});
/** Children kept in a sparse set. */
const HeldBy = Component.relation("rl/HeldBy", {
  onTargetDespawn: "despawn",
  storage: "sparse",
});

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): A =>
  Effect.runSync(Effect.scoped(effect));

const body = (world: EcsWorld, x = 0): Entity => world.spawn(Body.of({ x }));
const childOf = (world: EcsWorld, parent: Entity): Entity =>
  world.spawn(Body.of({ x: 0 }), ChildOf.of({ target: parent }));

// Any of them: what a loop over the four of them reads is `target`.
const all: readonly RelationDef[] = [ChildOf, Targets, Owes, HeldBy];

/** Every relation of a world points at a live entity, and `sources` agrees. */
const expectNoDangling = (world: EcsWorld): void => {
  for (const relation of all) {
    const byTarget = new Map<Entity, Entity[]>();
    world.view(Query.all(relation)).each((row, entity) => {
      expect(world.isAlive(row.target)).toBe(true);
      byTarget.set(row.target, [...(byTarget.get(row.target) ?? []), entity]);
    });
    for (const [target, sources] of byTarget) {
      expect(world.sources(target, relation)).toEqual(
        sources.toSorted((a, b) => (a & 0x3f_ff_ff) - (b & 0x3f_ff_ff))
      );
    }
  }
};

describe("a relation", () => {
  it("is a component that points at another entity, and knows who points at whom", () => {
    const world = new EcsWorld();
    const parent = body(world);
    const first = childOf(world, parent);
    const second = childOf(world, parent);
    const other = body(world);
    expect(world.get(first, ChildOf)).toEqual({ target: parent });
    expect(world.sources(parent, ChildOf)).toEqual([first, second]);
    expect(world.sources(other, ChildOf)).toEqual([]);
    expect(world.sources(parent, Targets)).toEqual([]);
    expect(
      world.sources(
        parent,
        // @ts-expect-error only a relation has sources
        Body
      )
    ).toEqual([]);
    // In a query it is read like any component.
    const seen: [Entity, Entity][] = [];
    world.view(Query.all(Body, ChildOf)).each((_, child, entity) => {
      seen.push([entity, child.target]);
    });
    expect(seen).toEqual([
      [first, parent],
      [second, parent],
    ]);
    world.view(Query.all(ChildOf)).eachChunk((start, end, child, ids) => {
      for (let i = start; i < end; i++) {
        expect(child.target[i]).toBe(parent);
        expect([first, second]).toContain(ids[i]);
      }
      if (start < 0) {
        // Never run: it is the compiler that refuses it.
        // @ts-expect-error a relation's target is not written through its column
        child.target[start] = parent;
      }
    });
    // Losing the relation is no longer pointing.
    world.remove(first, ChildOf);
    expect(world.sources(parent, ChildOf)).toEqual([second]);
    world.despawn(second);
    expect(world.sources(parent, ChildOf)).toEqual([]);
    expect(world.isAlive(parent)).toBe(true);
  });

  it("takes the children of a despawned parent with it, and theirs", () => {
    const world = new EcsWorld();
    const lost = world.removed(ChildOf);
    const root = body(world);
    const bystander = body(world);
    const kids = [childOf(world, root), childOf(world, root)];
    const grandkids = [childOf(world, kids[0]!), childOf(world, kids[0]!)];
    const great = childOf(world, grandkids[1]!);
    const adopted = childOf(world, bystander);
    expect(world.entityCount).toBe(8);

    expect(world.despawn(root)).toBe(true);
    for (const gone of [root, ...kids, ...grandkids, great]) {
      expect(world.isAlive(gone)).toBe(false);
    }
    expect(world.isAlive(bystander)).toBe(true);
    expect(world.isAlive(adopted)).toBe(true);
    expect(world.entityCount).toBe(2);
    // Each went as any despawned entity goes, its relation lost: a child
    // and all that hangs from it before the next child.
    expect(lost.read()).toEqual([
      kids[0],
      grandkids[0],
      grandkids[1],
      great,
      kids[1],
    ]);
    expectNoDangling(world);
    // Despawning a child leaves the parent be.
    world.despawn(adopted);
    expect(world.isAlive(bystander)).toBe(true);
  });

  it("takes a relation away, and not its holder, when it was told to remove", () => {
    const world = new EcsWorld();
    const prey = body(world, 1);
    const hunters = [0, 1, 2].map(() =>
      world.spawn(Body.of({ x: 5 }), Targets.of({ target: prey }))
    );
    const debtor = world.spawn(Owes.of({ target: prey, amount: 30 }));
    world.despawn(prey);
    for (const hunter of hunters) {
      expect(world.isAlive(hunter)).toBe(true);
      expect(world.has(hunter, Targets)).toBe(false);
      expect(world.get(hunter, Targets)).toBeUndefined();
      expect(world.get(hunter, Body)).toEqual({ x: 5 });
    }
    expect(world.isAlive(debtor)).toBe(true);
    expect(world.has(debtor, Owes)).toBe(false);
    // The slot is used again: nothing was left pointing at it to mistake
    // the newcomer for the one that died.
    const newcomer = body(world);
    expect(newcomer & 0x3f_ff_ff).toBe(prey & 0x3f_ff_ff);
    expect(world.sources(newcomer, Targets)).toEqual([]);
    expect(world.view(Query.all(Targets)).count()).toBe(0);
    // And what points at the newcomer does not point at the one that died.
    world.add(hunters[0]!, Targets.of({ target: newcomer }));
    expect(world.sources(newcomer, Targets)).toEqual([hunters[0]]);
    expect(world.sources(prey, Targets)).toEqual([]);
    expectNoDangling(world);
  });

  it("goes through relations in order of name, and holders in order of id", () => {
    // Two worlds that made their relations in opposite orders lose the
    // same entities in the same order, so the same ids come back.
    const build = (heldFirst: boolean): number[] => {
      const world = new EcsWorld();
      const target = body(world);
      const [held, child, both] = [body(world), body(world), body(world)];
      const steps = [
        () => world.add(held, HeldBy.of({ target })),
        () => world.add(child, ChildOf.of({ target })),
        () => world.add(both, HeldBy.of({ target })),
        () => world.add(both, ChildOf.of({ target })),
      ];
      for (const step of heldFirst ? steps : steps.toReversed()) {
        step();
      }
      const lost = [world.removed(ChildOf), world.removed(HeldBy)];
      world.despawn(target);
      expect(world.entityCount).toBe(0);
      // "rl/ChildOf" before "rl/HeldBy": the child and the one with both,
      // then the one that was only held.
      expect(lost[0]!.read()).toEqual([child, both]);
      expect(lost[1]!.read()).toEqual([both, held]);
      return [0, 1, 2, 3].map(() => world.spawn(Body) & 0x3f_ff_ff);
    };
    expect(build(true)).toEqual([1, 3, 2, 0]);
    expect(build(false)).toEqual([1, 3, 2, 0]);
  });

  it("is given another target by adding it again, and by nothing else", () => {
    const world = new EcsWorld();
    const [a, b] = [body(world), body(world)];
    const child = childOf(world, a);
    const debtor = world.spawn(Owes.of({ target: a, amount: 1 }));

    expect(world.add(child, ChildOf.of({ target: b }))).toBe(true);
    expect(world.get(child, ChildOf)).toEqual({ target: b });
    expect(world.sources(a, ChildOf)).toEqual([]);
    expect(world.sources(b, ChildOf)).toEqual([child]);
    world.add(debtor, Owes.of({ target: b, amount: 2 }));
    expect(world.get(debtor, Owes)).toEqual({ target: b, amount: 2 });
    expect(world.sources(a, Owes)).toEqual([]);

    // Its other fields are written like any field.
    world.set(debtor, Owes, { amount: 3 });
    world.view(Query.all(Owes).pipe(Query.writes(Owes))).each((owes) => {
      owes.amount += 1;
    });
    expect(world.get(debtor, Owes)).toEqual({ target: b, amount: 4 });
    // Its target is not, and doesn't compile: the world would lose track of
    // who points at whom. Past the type, it throws.
    expect(() =>
      world.set(debtor, Owes, {
        // @ts-expect-error a relation's target is not set like a field
        target: a,
      })
    ).toThrow(
      /"rl\/Owes" is a relation.*add\(entity, .*\.of\(\{ target \}\)\)/
    );
    expect(() =>
      world.view(Query.all(Owes).pipe(Query.writes(Owes))).each((owes) => {
        // @ts-expect-error a relation's target is read-only in a loop that writes
        owes.target = a;
      })
    ).toThrow(/is a relation/);
    // An undefined, which the type takes without exactOptionalPropertyTypes,
    // is left as it was, like a number not given.
    expect(world.set(debtor, Owes, { target: undefined } as never)).toBe(true);
    expect(world.get(debtor, Owes)).toEqual({ target: b, amount: 4 });
    expect(world.sources(b, Owes)).toEqual([debtor]);

    // The old target's despawn is nothing to it now; the new one's is.
    world.despawn(a);
    expect(world.isAlive(child)).toBe(true);
    world.despawn(b);
    expect(world.isAlive(child)).toBe(false);
    expect(world.has(debtor, Owes)).toBe(false);
  });

  it("needs a target, and one that is alive", () => {
    const world = new EcsWorld();
    const parent = body(world);
    const commands = new CommandBuffer(world);
    // Neither the world nor commands compile with a relation given bare.
    // Past the type, they throw where it is given.
    expect(() =>
      world.spawn(
        Body,
        // @ts-expect-error a relation needs a target
        ChildOf
      )
    ).toThrow(/"rl\/ChildOf" is a relation, and a relation needs a target/);
    expect(() =>
      world.add(
        parent,
        // @ts-expect-error a relation needs a target
        Targets
      )
    ).toThrow(/needs a target/);
    expect(() =>
      commands.spawn(
        // @ts-expect-error a relation needs a target
        ChildOf
      )
    ).toThrow(/needs a target/);
    expect(() =>
      commands.add(
        parent,
        // @ts-expect-error a relation needs a target
        ChildOf
      )
    ).toThrow(/needs a target/);
    expect(commands.size).toBe(0);
    expect(world.entityCount).toBe(1);

    const dead = body(world);
    world.despawn(dead);
    // What a dead target's despawn would have done is done at once.
    const orphan = world.spawn(Body, ChildOf.of({ target: dead }));
    expect(world.isAlive(orphan)).toBe(false);
    const hunter = world.spawn(Body, Targets.of({ target: dead }));
    expect(world.isAlive(hunter)).toBe(true);
    expect(world.has(hunter, Targets)).toBe(false);
    expect(world.add(hunter, Targets.of({ target: dead }))).toBe(false);
    expect(world.has(hunter, Targets)).toBe(false);

    // Aimed at something alive, then at something dead: it aims at nothing.
    world.add(hunter, Targets.of({ target: parent }));
    expect(world.add(hunter, Targets.of({ target: dead }))).toBe(false);
    expect(world.has(hunter, Targets)).toBe(false);
    expect(world.sources(parent, Targets)).toEqual([]);
    const child = childOf(world, parent);
    expect(world.add(child, ChildOf.of({ target: dead }))).toBe(false);
    expect(world.isAlive(child)).toBe(false);
    expect(world.sources(parent, ChildOf)).toEqual([]);
    expectNoDangling(world);
  });

  it("works the same kept in a sparse set", () => {
    const world = new EcsWorld();
    const hand = body(world);
    const cards = [0, 1, 2].map(() =>
      world.spawn(Body, HeldBy.of({ target: hand }))
    );
    const other = body(world);
    world.add(cards[1]!, HeldBy.of({ target: other }));
    expect(world.sources(hand, HeldBy)).toEqual([cards[0], cards[2]]);
    expect(world.sources(other, HeldBy)).toEqual([cards[1]]);
    world.remove(cards[2]!, HeldBy);
    world.despawn(hand);
    expect(cards.map((card) => world.isAlive(card))).toEqual([
      false,
      true,
      true,
    ]);
    world.despawn(other);
    expect(world.isAlive(cards[1]!)).toBe(false);
    expect(world.isAlive(cards[2]!)).toBe(true);
  });

  it("comes to an end on a loop, and on a chain ten thousand long", () => {
    const world = new EcsWorld();
    const self = body(world);
    world.add(self, ChildOf.of({ target: self }));
    expect(world.sources(self, ChildOf)).toEqual([self]);
    world.despawn(self);
    expect(world.entityCount).toBe(0);

    const [a, b, c] = [body(world), body(world), body(world)];
    world.add(a, ChildOf.of({ target: b }));
    world.add(b, ChildOf.of({ target: c }));
    world.add(c, ChildOf.of({ target: a }));
    world.despawn(b);
    expect(world.entityCount).toBe(0);

    let last = body(world);
    const first = last;
    for (let n = 0; n < 10_000; n++) {
      last = childOf(world, last);
    }
    expect(world.entityCount).toBe(10_001);
    world.despawn(first);
    expect(world.entityCount).toBe(0);
  });

  it("is followed when the change comes through Commands", () => {
    const world = new EcsWorld();
    const commands = new CommandBuffer(world);
    const parent = body(world);
    // A child queued before the parent it names is placed: the id is taken.
    const queuedParent = commands.spawn(Body);
    const child = commands.spawn(Body, ChildOf.of({ target: queuedParent }));
    const sibling = commands.spawn(Body, ChildOf.of({ target: parent }));
    commands.apply();
    expect(world.sources(queuedParent, ChildOf)).toEqual([child]);
    commands.add(sibling, ChildOf.of({ target: queuedParent }));
    commands.despawn(queuedParent);
    // The despawn has not happened yet: nothing has gone.
    expect(world.isAlive(child)).toBe(true);
    commands.apply();
    expect([child, sibling, queuedParent].map((e) => world.isAlive(e))).toEqual(
      [false, false, false]
    );
    expect(world.isAlive(parent)).toBe(true);

    // A target whose queued spawn is taken back is a target that is gone.
    const mark = commands.mark();
    const never = commands.spawn(Body);
    const hunter = world.spawn(Body, Targets.of({ target: never }));
    const orphan = world.spawn(Body, ChildOf.of({ target: never }));
    commands.rollback(mark);
    expect(world.isAlive(never)).toBe(false);
    expect(world.has(hunter, Targets)).toBe(false);
    expect(world.isAlive(orphan)).toBe(false);
    expectNoDangling(world);
  });

  it("does not change inside a transaction, where an action's handler runs", () => {
    const world = new EcsWorld();
    const [a, b] = [body(world), body(world)];
    const child = childOf(world, a);
    const before = world.hash();
    world.begin();
    expect(() => world.add(child, ChildOf.of({ target: b }))).toThrow(
      /inside a transaction.*Queue it on Commands/
    );
    expect(() => world.despawn(a)).toThrow(/inside a transaction/);
    world.rollback();
    expect(world.hash()).toBe(before);
    expect(world.sources(a, ChildOf)).toEqual([child]);
  });
});

describe("relations and a snapshot", () => {
  /** A family tree with debts, built in the order given. */
  const family = (order: readonly number[]): EcsWorld => {
    const world = new EcsWorld({ seed: 4 });
    const parents = [body(world, 1), body(world, 2)];
    const children = [0, 1, 2, 3, 4, 5].map((n) => body(world, 10 + n));
    for (const n of order) {
      world.add(children[n]!, ChildOf.of({ target: parents[n % 2]! }));
      world.add(children[n]!, Targets.of({ target: children[(n + 1) % 6]! }));
    }
    world.add(children[5]!, Owes.of({ target: parents[0]!, amount: 7 }));
    return world;
  };
  const listed = [Body, ChildOf, Targets, Owes, HeldBy];

  it("go on the same after a load: the same entities go, and the same ids come back", () => {
    const world = family([0, 1, 2, 3, 4, 5]);
    const copy = new EcsWorld();
    copy.load(world.snapshot(), listed);
    expect(copy.hash()).toBe(world.hash());
    expectNoDangling(copy);
    const parents = world.view(Query.all(Body)).entities().slice(0, 2);
    expect(copy.sources(parents[0]!, ChildOf)).toEqual(
      world.sources(parents[0]!, ChildOf)
    );
    for (const each of [world, copy]) {
      each.despawn(parents[0]!);
      each.spawn(Body.of({ x: 100 }));
      each.spawn(Body.of({ x: 101 }));
    }
    expect(copy.hash()).toBe(world.hash());
    expect(copy.entityCount).toBe(world.entityCount);
    expect(copy.view(Query.all(Body)).entities()).toEqual(
      world.view(Query.all(Body)).entities()
    );
    expectNoDangling(copy);
  });

  it("do not depend on the order the relations were made in", () => {
    const one = family([0, 1, 2, 3, 4, 5]);
    const other = family([5, 3, 1, 4, 2, 0]);
    // The tables hold the children in another order, so compare what goes.
    const survivors = (world: EcsWorld): number[] => {
      const parent = world.view(Query.all(Body)).entities()[0]!;
      world.despawn(parent);
      const xs: number[] = [];
      world.view(Query.all(Body)).each((row) => {
        xs.push(row.x);
      });
      return xs.toSorted((a, b) => a - b);
    };
    expect(survivors(other)).toEqual(survivors(one));
    // And the slots they left are reused in the same order.
    expect([body(other), body(other), body(other)]).toEqual([
      body(one),
      body(one),
      body(one),
    ]);
  });

  it("refuses a snapshot whose relation points at an entity that is not there", () => {
    const world = family([0, 1, 2]);
    const contents = readSnapshot(world.snapshot());
    const table = contents.tables.find((each) =>
      each.components.includes("rl/ChildOf")
    )!;
    (table.columns["rl/ChildOf"]!.target as Uint32Array)[0] = 4000;
    let error: unknown;
    try {
      new EcsWorld().load(writeSnapshot(contents), listed);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(SnapshotError);
    expect((error as SnapshotError).problem).toBe("corrupt");
    expect((error as SnapshotError).message).toMatch(
      /"rl\/ChildOf" points at an entity that does not exist/
    );
  });
});

describe("relations against a simple model", () => {
  for (const seed of [1, 2, 3]) {
    it(`agree with it through thousands of random operations (seed ${seed})`, () => {
      const dice = new EcsWorld({ seed }).random;
      const world = new EcsWorld();
      const relations = [ChildOf, Targets, Owes, HeldBy] as const;
      /** Per relation: who points at whom. */
      const model = relations.map(() => new Map<Entity, Entity>());
      const alive = new Set<Entity>();
      /** What a despawn does, worked out the slow way. */
      const kill = (entity: Entity): void => {
        const pending = [entity];
        while (pending.length > 0) {
          const next = pending.pop()!;
          if (!alive.delete(next)) {
            continue;
          }
          for (const [r, relation] of relations.entries()) {
            model[r]!.delete(next);
            for (const [source, target] of model[r]!) {
              if (target !== next) {
                continue;
              }
              if (relation.relation === "despawn") {
                pending.push(source);
              } else {
                model[r]!.delete(source);
              }
            }
          }
        }
      };
      const relate = (r: number, source: Entity, target: Entity): void => {
        if (alive.has(target)) {
          model[r]!.set(source, target);
        } else if (relations[r]!.relation === "despawn") {
          kill(source);
        } else {
          model[r]!.delete(source);
        }
      };
      const graveyard: Entity[] = [];
      const anyone = (): Entity =>
        graveyard.length > 0 && dice.next() < 0.1
          ? dice.pick(graveyard)
          : dice.pick(Array.from(alive));

      for (let step = 0; step < 4000; step++) {
        const roll = dice.int(0, 9);
        if (roll < 3 || alive.size < 3) {
          const r = dice.int(0, relations.length - 1);
          const target = alive.size > 0 ? anyone() : undefined;
          const related = target !== undefined && dice.next() < 0.7;
          const entity = related
            ? world.spawn(
                Body,
                r === 2
                  ? Owes.of({ target, amount: 1 })
                  : relations[r]!.of({ target } as never)
              )
            : world.spawn(Body);
          alive.add(entity);
          if (related) {
            relate(r, entity, target);
          }
        } else if (roll < 6) {
          const r = dice.int(0, relations.length - 1);
          const source = dice.pick(Array.from(alive));
          const target = anyone();
          world.add(
            source,
            r === 2
              ? Owes.of({ target, amount: 2 })
              : relations[r]!.of({ target } as never)
          );
          relate(r, source, target);
        } else if (roll < 7) {
          const r = dice.int(0, relations.length - 1);
          const source = dice.pick(Array.from(alive));
          world.remove(source, relations[r]!);
          model[r]!.delete(source);
        } else {
          const entity = dice.pick(Array.from(alive));
          world.despawn(entity);
          kill(entity);
          graveyard.push(entity);
        }

        expect(world.entityCount).toBe(alive.size);
        expect([...alive].filter((entity) => !world.isAlive(entity))).toEqual(
          []
        );
        for (const [r, relation] of all.entries()) {
          const held = new Map<Entity, Entity>();
          world.view(Query.all(relation)).each((row, entity) => {
            held.set(entity, row.target);
          });
          expect(held).toEqual(model[r]);
        }
        expectNoDangling(world);
      }
    });
  }
});

// --- in an app --------------------------------------------------------------------

const Fell = Action.define("rl/Fell", Schema.Struct({ tree: EntityId }));
const Graft = Action.define(
  "rl/Graft",
  Schema.Struct({ branch: EntityId, onto: EntityId })
);
const fell = Action.handler(Fell, function* ({ tree }) {
  (yield* Commands).despawn(tree);
});
const graft = Action.handler(Graft, function* ({ branch, onto }) {
  const world = yield* World;
  if (!world.isAlive(onto)) {
    return yield* Effect.fail("no such tree" as const);
  }
  (yield* Commands.spawns(ChildOf)).add(branch, ChildOf.of({ target: onto }));
  return world.sources(onto, ChildOf).length;
});
/** Every tick, each tree that has branches grows one more. */
const Grow = System.tick("Grow", function* () {
  const world = yield* World;
  const commands = yield* Commands.spawns(Body, ChildOf);
  (yield* Query.all(Body).pipe(Query.without(ChildOf))).each((_, tree) => {
    if (world.sources(tree, ChildOf).length > 0) {
      commands.spawn(Body, ChildOf.of({ target: tree }));
    }
  });
});

/** How the orchard begins: three trees, each with a first branch. */
const Planted = Plugin.make("rl/Planted", {
  setup: Effect.map(Commands.spawns(Body, ChildOf), (commands) => {
    const trees = [0, 1, 2].map(() => commands.spawn(Body));
    for (const tree of trees) {
      commands.spawn(Body, ChildOf.of({ target: tree }));
    }
  }),
});
const Orchard = App.define({
  plugins: [Planted],
  systems: [Grow],
  handlers: [fell, graft],
});

/** The trees, read from outside the game: the bodies that are nobody's branch. */
const Trees = Query.all(Body).pipe(Query.without(ChildOf));

const orchard = Effect.gen(function* () {
  const app = yield* App.make(Orchard, { checkpointEvery: 1 });
  const world = yield* app.read(World);
  // In the order planted.
  const [first, second, third] = (yield* app.read(Trees)).entities();
  assert(first !== undefined && second !== undefined && third !== undefined);
  return { app, world, trees: [first, second, third] as const };
});

describe("relations in an app", () => {
  it("are handed to a system with a target it reads, and its other fields to write", () => {
    const Accrue = System.tick("rl/Accrue", function* () {
      const world = yield* World.writes(Owes);
      const commands = yield* Commands.spawns(Body, Owes);
      (yield* Query.all(Owes).pipe(Query.writes(Owes))).each((owes, debtor) => {
        owes.amount += 1;
        if (owes.amount < 0) {
          // Never run: it is the compiler that refuses each of these.
          // @ts-expect-error a relation's target is read-only in a loop that writes
          owes.target = debtor;
          world.set(debtor, Owes, {
            // @ts-expect-error a relation's target is not set like a field
            target: debtor,
          });
          commands.spawn(
            Body,
            // @ts-expect-error a relation needs a target
            Owes
          );
          commands.add(
            debtor,
            // @ts-expect-error a relation needs a target
            Owes
          );
          world.sources(
            debtor,
            // @ts-expect-error only a relation has sources
            Body
          );
        }
      });
      const lender = commands.spawn(Body);
      commands.spawn(Body, Owes.of({ target: lender, amount: 0 }));
    });
    run(
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ systems: [Accrue] }));
        const world = yield* app.read(World);
        app.tick(1);
        app.tick(1);
        const lenders = (yield* app.read(
          Query.all(Body).pipe(Query.without(Owes))
        )).entities();
        expect(
          lenders.map((lender) => world.sources(lender, Owes).length)
        ).toEqual([1, 1]);
        const [first] = lenders;
        assert(first !== undefined);
        const [debtor] = world.sources(first, Owes);
        assert(debtor !== undefined);
        expect(world.get(debtor, Owes)).toEqual({ target: first, amount: 1 });
      })
    );
  });

  it("are kept through actions and systems, and a game with them replays", () => {
    run(
      Effect.gen(function* () {
        const {
          app,
          world,
          trees: [first, second],
        } = yield* orchard;
        app.tick(1);
        app.tick(1);
        expect(world.sources(first, ChildOf).length).toBe(3);
        const [branch] = world.sources(first, ChildOf);
        assert(branch !== undefined);
        // A handler changes who points at whom through Commands.
        expect(app.dispatch(Graft, { branch, onto: second })).toEqual(
          Exit.succeed(3)
        );
        expect(world.sources(second, ChildOf).length).toBe(4);
        app.dispatch(Fell, { tree: first });
        expect(world.isAlive(first)).toBe(false);
        expect(world.isAlive(branch)).toBe(true);
        expect(world.sources(first, ChildOf)).toEqual([]);
        app.enqueue(Fell, { tree: second });
        app.tick(1);
        expect(world.isAlive(branch)).toBe(false);
        // One tree is left, with the branches of three ticks and its first.
        expect(world.entityCount).toBe(5);

        const played = app.record();
        const again = yield* Journal.replay(played, (start) =>
          App.make(Orchard, { ...start, checkpointEvery: 1 })
        );
        expect((yield* again.read(World)).hash()).toBe(world.hash());
      })
    );
  });

  it("are saved with a game, and the loaded game goes on the same", () => {
    run(
      Effect.gen(function* () {
        const {
          app,
          world,
          trees: [first, , third],
        } = yield* orchard;
        app.tick(1);
        const save = app.save();
        if (Exit.isFailure(save)) {
          throw new Error("the save was refused");
        }
        const read = Save.decode(Save.encode(save.value));
        if (Exit.isFailure(read)) {
          throw new Error("the save did not decode");
        }
        const loaded = yield* App.make(
          App.define({ systems: [Grow], handlers: [fell, graft] }),
          { save: read.value, checkpointEvery: 1 }
        );
        for (const each of [app, loaded]) {
          each.dispatch(Fell, { tree: third });
          each.tick(1);
          each.tick(1);
        }
        const loadedWorld = yield* loaded.read(World);
        expect(loadedWorld.hash()).toBe(world.hash());
        expect(loadedWorld.sources(first, ChildOf)).toEqual(
          world.sources(first, ChildOf)
        );
        // Two trees are left, each with its first branch and three more.
        expect(loadedWorld.entityCount).toBe(10);
      })
    );
  });
});
