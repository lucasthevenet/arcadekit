import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";

import type { ReadonlyColumnsOf } from "../src/ecs/component.ts";
import { entityIndex } from "../src/ecs/index.ts";
import { World as EcsWorld } from "../src/ecs/index.ts";
import type { RowOf } from "../src/ecs/relation.ts";
import {
  Action,
  App,
  Component,
  Field,
  Query,
  Timeline,
} from "../src/index.ts";
import type { ComponentDef, Entity } from "../src/index.ts";
import { partsOf } from "../src/internal/parts.ts";
import { withApp } from "./peers.ts";

const Position = Component.define("mb/Position", { x: Field.f32 });
const Rotation = Component.define("mb/Rotation", { a: Field.f32 });
const Scale = Component.define("mb/Scale", { s: Field.f32 });
const Heat = Component.define(
  "mb/Heat",
  { degrees: Field.f32 },
  { storage: "sparse" }
);
const ChildOf = Component.relation("mb/ChildOf", {
  onTargetDespawn: "remove",
});

const Drawn = Query.all(Position, Query.maybe(Rotation), Query.maybe(Scale));
const Spinning = Query.all(Position, Query.maybe(Rotation)).pipe(
  Query.writes(Rotation)
);

/** Tables made in the order P, PR, PS, PRS, R; the PRS entity is also hot. */
const populated = (): { world: EcsWorld; entities: Entity[] } => {
  const world = new EcsWorld();
  const entities = [
    world.spawn(Position.of({ x: 0 })),
    world.spawn(Position.of({ x: 1 }), Rotation.of({ a: 1 })),
    world.spawn(Position.of({ x: 2 }), Scale.of({ s: 2 })),
    world.spawn(
      Position.of({ x: 3 }),
      Rotation.of({ a: 3 }),
      Scale.of({ s: 3 })
    ),
    world.spawn(Position.of({ x: 4 })),
    world.spawn(Rotation.of({ a: 5 })),
  ];
  world.add(entities[3]!, Heat.of({ degrees: 1 }));
  return { world, entities };
};

describe("a term an entity may lack", () => {
  it("is a row or undefined in each, and columns or undefined in eachChunk", () => {
    const world = new EcsWorld();
    world.view(Drawn).each((position, rotation) => {
      expectTypeOf(position).toEqualTypeOf<
        Readonly<RowOf<typeof Position.schema>>
      >();
      expectTypeOf(rotation).toEqualTypeOf<
        Readonly<RowOf<typeof Rotation.schema>> | undefined
      >();
    });
    world.view(Spinning).each((_position, rotation) => {
      expectTypeOf(rotation).toEqualTypeOf<
        RowOf<typeof Rotation.schema> | undefined
      >();
    });
    world.view(Drawn).eachChunk((_start, _end, _position, rotation) => {
      expectTypeOf(rotation).toEqualTypeOf<
        ReadonlyColumnsOf<typeof Rotation.schema> | undefined
      >();
    });
  });

  it("doesn't decide which entities match, and is handed out per table, in the usual order", () => {
    const { world, entities } = populated();
    const seen: [number, number | undefined, number | undefined][] = [];
    world.view(Drawn).each((position, rotation, scale) => {
      seen.push([position.x, rotation?.a, scale?.s]);
    });
    expect(seen).toEqual([
      [0, undefined, undefined],
      [4, undefined, undefined],
      [1, 1, undefined],
      [2, undefined, 2],
      [3, 3, 3],
    ]);
    const runs: [number, number, boolean, boolean][] = [];
    world.view(Drawn).eachChunk((start, end, _position, rotation, scale) => {
      runs.push([start, end, rotation !== undefined, scale !== undefined]);
    });
    expect(runs).toEqual([
      [0, 2, false, false],
      [0, 1, true, false],
      [0, 1, false, true],
      [0, 1, true, true],
    ]);
    expect(world.view(Drawn).entities()).toEqual([
      entities[0],
      entities[4],
      entities[1],
      entities[2],
      entities[3],
    ]);
    expect(world.view(Drawn).count()).toBe(5);
  });

  it("makes a query of its own, apart from the one that requires the component", () => {
    const { world } = populated();
    expect(world.view(Query.all(Position, Rotation)).count()).toBe(2);
    expect(world.view(Query.all(Position, Query.maybe(Rotation))).count()).toBe(
      5
    );
  });

  it("goes with filters", () => {
    const { world } = populated();
    const hot: (number | undefined)[] = [];
    world
      .view(Drawn.pipe(Query.with(Heat)))
      .each((_position, rotation) => hot.push(rotation?.a));
    expect(hot).toEqual([3]);
    expect(world.view(Drawn.pipe(Query.with(Rotation))).count()).toBe(2);
    const without: (number | undefined)[] = [];
    world
      .view(Drawn.pipe(Query.without(Rotation)))
      .each((_position, rotation) => without.push(rotation?.a));
    expect(without).toEqual([undefined, undefined, undefined]);
  });

  it("can be a relation, whose target stays the world's", () => {
    const world = new EcsWorld();
    const parent = world.spawn(Position.of({ x: 0 }));
    world.spawn(Position.of({ x: 1 }), ChildOf.of({ target: parent }));
    const Family = Query.all(Position, Query.maybe(ChildOf)).pipe(
      Query.writes(ChildOf)
    );
    const targets: (Entity | undefined)[] = [];
    world.view(Family).each((_position, child) => {
      targets.push(child?.target);
    });
    expect(targets).toEqual([undefined, parent]);
    expect(() =>
      world.view(Family).each((_position, child) => {
        if (child !== undefined) {
          // @ts-expect-error a relation's target is read-only
          child.target = parent;
        }
      })
    ).toThrow(/target/);
  });

  it("is written only where it is handed out", () => {
    const { world, entities } = populated();
    world.view(Spinning).each((_position, rotation) => {
      if (rotation !== undefined) {
        rotation.a += 10;
      }
    });
    expect(entities.map((entity) => world.get(entity, Rotation)?.a)).toEqual([
      undefined,
      11,
      undefined,
      13,
      undefined,
      5,
    ]);
  });

  it("counts as written in a raw loop only for the entities that have it", () => {
    const { world, entities } = populated();
    const Turned = Query.all(Rotation).pipe(Query.changed(Rotation));
    world.view(Turned).entities();
    world.view(Spinning).eachChunk(() => {});
    expect(world.view(Turned).count()).toBe(2);
    // What a save keeps for the reader names those entities and no other.
    const saved = world
      .saveChanges()
      .find(
        ({ component, kind }) =>
          component === Rotation.name && kind === "changed"
      );
    expect(saved?.entries).toEqual(
      [entities[1]!, entities[3]!].map((entity) => entityIndex(entity))
    );
  });

  it.effect(
    "is put back by a rewind where a table has it, and hashed as a full hash is",
    () =>
      Effect.gen(function* () {
        const Turn = Action.define("mb/Turn", Schema.Struct({}));
        const turn = Action.handler(Turn, function* () {
          (yield* Spinning).each((_position, rotation) => {
            if (rotation !== undefined) {
              rotation.a += 10;
            }
          });
          (yield* Spinning).eachChunk((start, end, _position, rotation) => {
            for (let i = start; rotation !== undefined && i < end; i++) {
              rotation.a[i] = rotation.a[i]! + 1;
            }
          });
        });
        yield* withApp(App.make(App.define({ handlers: [turn] })), (app) =>
          Effect.gen(function* () {
            const { world } = partsOf(app);
            const placed = world.spawn(Position.of({ x: 0 }));
            const turned = world.spawn(
              Position.of({ x: 1 }),
              Rotation.of({ a: 1 })
            );
            const before = world.hash();
            const moment = yield* Effect.exit(Timeline.capture(app));
            if (Exit.isFailure(moment)) {
              throw new Error("the game could not be captured");
            }
            yield* app.dispatch(Turn, {});
            expect(world.get(turned, Rotation)).toEqual({ a: 12 });
            expect(world.hash()).not.toBe(before);
            expect(world.hash()).toBe(world._fullHash());
            yield* Timeline.rewind(app, moment.value);
            expect(world.get(turned, Rotation)).toEqual({ a: 1 });
            expect(world.get(placed, Rotation)).toBeUndefined();
            expect(world.hash()).toBe(before);
            expect(world.hash()).toBe(world._fullHash());
          })
        );
      })
  );

  it("is checked for writes past the compiler where a table has it", () => {
    const { world } = populated();
    world._checkReads = true;
    expect(() =>
      world.view(Drawn).eachChunk((start, _end, _position, rotation) => {
        if (rotation !== undefined) {
          (rotation.a as Float32Array)[start] = 7;
        }
      })
    ).toThrow(/only reads/);
    expect(world.get(populated().entities[1]!, Rotation)).toEqual({ a: 1 });
  });

  it("hands out what a spawn or an add filled in", () => {
    const Turned = Component.tag("mb/Turned", {
      requires: [Rotation.of({ a: 9 })],
    });
    const world = new EcsWorld();
    world.spawn(Position.of({ x: 0 }), Turned);
    const later = world.spawn(Position.of({ x: 1 }));
    const seen = (): (number | undefined)[] => {
      const angles: (number | undefined)[] = [];
      world.view(Drawn).each((_position, rotation) => {
        angles.push(rotation?.a);
      });
      return angles;
    };
    expect(seen()).toEqual([9, undefined]);
    world.add(later, Turned);
    expect(seen()).toEqual([9, 9]);
  });

  it("is refused for a sparse component", () => {
    // @ts-expect-error only a component stored in tables
    expect(() => Query.maybe(Heat)).toThrow(/sparse component/);
    const known: ComponentDef = Heat;
    expect(() => Query.all(Position, Query.maybe(known))).toThrow(
      /sparse component/
    );
    expect(() => new Query.Maybe(known)).toThrow(/sparse component/);
  });

  it("is refused by a change query that watches it", () => {
    // @ts-expect-error a change query requires what it watches
    expect(() => Drawn.pipe(Query.changed(Rotation))).toThrow(/Query.maybe/);
    // @ts-expect-error a change query requires what it watches
    expect(() => Drawn.pipe(Query.added(Scale))).toThrow(/Query.maybe/);
    // @ts-expect-error a change query requires what it watches
    expect(() => Query.changed(Drawn, Rotation)).toThrow(/Query.maybe/);
    const known: ComponentDef = Rotation;
    expect(() => Drawn.pipe(Query.changed(known))).toThrow(/Query.maybe/);
    const Moved = Drawn.pipe(Query.changed(Position));
    expect(Moved.changedDefs).toEqual([Position]);
  });
});
