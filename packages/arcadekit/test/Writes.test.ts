import { Data, Effect, Exit, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  Action,
  App,
  Component,
  EcsWorld,
  Field,
  Query,
  System,
} from "../src/index";
import type { Entity } from "../src/index";

// Two components with the same fields: a query has to tell them apart.
const Position = Component.define("rd/Position", {
  x: Field.f32,
  y: Field.f32,
});
const Velocity = Component.define("rd/Velocity", {
  x: Field.f32,
  y: Field.f32,
});
const Heat = Component.define(
  "rd/Heat",
  { degrees: Field.f32 },
  { storage: "sparse" }
);
const Boss = Component.tag("rd/Boss");

/** Moves by a velocity it only reads. */
const Moving = Query.all(Position, Velocity).pipe(Query.writes(Position));
/** Reads everything it is handed, as a query does that names nothing. */
const Looking = Query.all(Position, Velocity, Heat);
const Moved = Query.all(Position).pipe(Query.changed(Position));
const Turned = Query.all(Velocity).pipe(Query.changed(Velocity));

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): A =>
  Effect.runSync(Effect.scoped(effect));

const populated = (count = 6): { world: EcsWorld; entities: Entity[] } => {
  const world = new EcsWorld();
  const entities: Entity[] = [];
  for (let n = 0; n < count; n++) {
    const entity = world.spawn(
      Position.of({ x: n, y: 0 }),
      Velocity.of({ x: 1, y: 2 })
    );
    if (n % 2 === 0) {
      world.add(entity, Heat.of({ degrees: n }));
    }
    entities.push(entity);
  }
  return { world, entities };
};

describe("a query, which writes only what it names", () => {
  it("reads every term, and refuses to write one it does not name through each", () => {
    const { entities, world } = populated();
    world.view(Moving).each((pos, vel) => {
      pos.x += vel.x;
      pos.y += vel.y;
    });
    expect(world.get(entities[3]!, Position)).toEqual({ x: 4, y: 2 });
    expect(() =>
      world.view(Moving).each((pos, vel) => {
        pos.x = 0;
        // @ts-expect-error Velocity is only read by this query
        vel.x = 9;
      })
    ).toThrow(
      /"rd\/Velocity\.x" was assigned to through a query that only reads "rd\/Velocity".*Query\.writes/
    );
    expect(world.get(entities[0]!, Velocity)).toEqual({ x: 1, y: 2 });
    // The same components through a query that names both are written.
    world
      .view(
        Query.all(Position, Velocity).pipe(Query.writes(Position, Velocity))
      )
      .each((pos, vel) => {
        vel.x = pos.x;
        pos.y = 0;
      });
    expect(world.get(entities[3]!, Velocity)!.x).toBe(4);
    // A sparse component, and all of a query's terms at once.
    let sum = 0;
    world.view(Looking).each((pos, vel, heat) => {
      sum += pos.x + vel.y + heat.degrees;
    });
    expect(sum).toBe(0 + 3 + 5 + 6 + 6);
    for (const write of [
      () =>
        world.view(Looking).each((pos) => {
          // @ts-expect-error every term of this query is only read
          pos.x = 1;
        }),
      () =>
        world.view(Looking).each((_, vel) => {
          // @ts-expect-error every term of this query is only read
          vel.y = 1;
        }),
      () =>
        world.view(Looking).each((_, __, heat) => {
          // @ts-expect-error every term of this query is only read
          heat.degrees = 1;
        }),
    ]) {
      expect(write).toThrow(/was assigned to through a query that only reads/);
    }
  });

  it("hands out raw columns that the compiler will not write", () => {
    const { world } = populated();
    let sum = 0;
    world.view(Moving).eachChunk((start, end, pos, vel) => {
      for (let i = start; i < end; i++) {
        pos.x[i] = pos.x[i]! + vel.x[i]!;
        sum += vel.y[i]!;
        if (start < 0) {
          // Never run: it is the compiler that refuses it.
          // @ts-expect-error Velocity is only read by this query
          vel.x[i] = 0;
        }
      }
      expect(vel.x.length).toBeGreaterThanOrEqual(end);
    });
    expect(sum).toBe(12);
    world.view(Looking).eachChunk((start, end, pos, vel, heat, ids) => {
      for (let i = start; i < end; i++) {
        sum += pos.x[i]! + heat.columns.degrees[heat.indexOf(ids[i]!)]!;
        if (start < 0) {
          // @ts-expect-error every term of this query is only read
          pos.x[i] = 0;
          // @ts-expect-error every term of this query is only read
          heat.columns.degrees[0] = 0;
          // @ts-expect-error every term of this query is only read
          vel.y[i] = 0;
        }
      }
    });
    expect(sum).toBe(12 + 1 + 3 + 5 + 0 + 2 + 4);
  });

  it("does not count what it only reads as written, in a raw loop", () => {
    const { entities, world } = populated();
    const moved = world.view(Moved, "watcher");
    const turned = world.view(Turned, "watcher");
    moved.entities();
    turned.entities();
    world.view(Moving).eachChunk(() => {});
    // The positions were handed out to be written; the velocities were not.
    expect(moved.entities()).toEqual(entities);
    expect(turned.entities()).toEqual([]);
    world.view(Looking).eachChunk(() => {});
    expect(moved.entities()).toEqual([]);
    expect(turned.entities()).toEqual([]);
    // What it names, every row that is handed out counts.
    world
      .view(Query.all(Position, Velocity).pipe(Query.writes(Velocity)))
      .eachChunk(() => {});
    expect(moved.entities()).toEqual([]);
    expect(turned.entities()).toEqual(entities);
  });

  it("lets a change query read what it watches with raw columns", () => {
    const { entities, world } = populated();
    const Drawn = Query.all(Position, Velocity).pipe(
      Query.changed(Position),
      Query.writes(Velocity)
    );
    const drawn = world.view(Drawn);
    const visit = (): number[] => {
      const seen: number[] = [];
      drawn.eachChunk((start, end, pos) => {
        for (let i = start; i < end; i++) {
          seen.push(pos.x[i]!);
        }
      });
      return seen;
    };
    expect(visit()).toEqual([0, 1, 2, 3, 4, 5]);
    // It did not take its own visit for a change.
    expect(visit()).toEqual([]);
    world.set(entities[4]!, Position, { x: 40 });
    expect(visit()).toEqual([40]);
    expect(visit()).toEqual([]);
    // But what it is handed and writes counts for others.
    expect(world.view(Turned).entities()).toEqual(entities);
    visit();
    world.set(entities[1]!, Position, { x: 10 });
    visit();
    expect(world.view(Turned).entities()).toEqual([entities[1]]);
    // One that hands out what it watches, to be written, is refused.
    const Rewritten = Moved.pipe(Query.writes(Position));
    expect(() => world.view(Rewritten).eachChunk(() => {})).toThrow(
      /watches "rd\/Position" for changes and also hands it out.*Query\.writes/
    );
  });

  it("is not saved for a rollback: what is only read is not copied", () => {
    const { entities, world } = populated();
    const before = world.hash();
    world.begin();
    world.view(Moving).each((pos, vel) => {
      pos.x += vel.x;
    });
    world.view(Moving).eachChunk((start, end, pos, vel) => {
      for (let i = start; i < end; i++) {
        pos.y[i] = vel.y[i]!;
      }
    });
    world.rollback();
    expect(world.hash()).toBe(before);
    // Having named nothing, a loop that writes all the same, past the
    // compiler, is on its own: there is no copy to put back.
    world.begin();
    world.view(Looking).eachChunk((start, end, pos, _, heat) => {
      for (let i = start; i < end; i++) {
        (pos.y as unknown as Float32Array)[i] = 77;
      }
      (heat.columns.degrees as unknown as Float32Array)[0] = 77;
    });
    world.rollback();
    expect(world.get(entities[0]!, Position)!.y).toBe(77);
    expect(world.get(entities[0]!, Heat)!.degrees).toBe(77);
    expect(world.get(entities[1]!, Position)!.y).toBe(0);
  });

  it("names components of the query, and keeps its word however the query is put together", () => {
    expect(() => Query.all(Position).pipe(Query.writes(Velocity))).toThrow(
      /Query\.writes was given "rd\/Velocity", which is not one of the query's terms: rd\/Position/
    );
    // It names at least one: a query that writes nothing names nothing.
    // @ts-expect-error Query.writes is given at least one component
    void (() => Query.writes());
    const { world } = populated();
    const built = [
      Query.all(Position, Velocity).pipe(
        Query.writes(Position),
        Query.with(Heat),
        Query.without(Boss),
        Query.changed(Position),
        Query.added(Heat)
      ),
      Query.all(Position, Velocity).pipe(
        Query.added(Heat),
        Query.changed(Position),
        Query.without(Boss),
        Query.with(Heat),
        Query.writes(Position)
      ),
      Query.writes(
        Query.all(Position, Velocity).pipe(
          Query.with(Heat),
          Query.without(Boss),
          Query.changed(Position),
          Query.added(Heat)
        ),
        Position
      ),
    ];
    for (const query of built) {
      expect(query.readDefs).toEqual([Velocity]);
      expect(() =>
        world.view(query, "anyone").each((pos, vel) => {
          pos.x = 1;
          // @ts-expect-error Velocity is only read by this query
          vel.x = 1;
        })
      ).toThrow(/only reads "rd\/Velocity"/);
    }
    // To one reader, the three are one query, and not the query that
    // writes nothing, or everything.
    expect(world.view(built[0]!, "reader")).toBe(
      world.view(built[1]!, "reader")
    );
    expect(world.view(built[0]!, "reader")).toBe(
      world.view(built[2]!, "reader")
    );
    const plain = Query.all(Position, Velocity).pipe(
      Query.with(Heat),
      Query.without(Boss),
      Query.changed(Position),
      Query.added(Heat)
    );
    expect(world.view(plain, "reader")).not.toBe(
      world.view(built[0]!, "reader")
    );
    expect(
      world.view(plain.pipe(Query.writes(Velocity, Position)), "reader")
    ).not.toBe(world.view(built[0]!, "reader"));
    // Said in two steps, it writes both; and a description that is not a
    // Query, with the same components in another order, is the same query.
    const twice = Query.all(Position, Velocity).pipe(
      Query.changed(Position),
      Query.writes(Velocity),
      Query.writes(Position)
    );
    expect(twice.writeDefs).toEqual([Position, Velocity]);
    expect(twice.readDefs).toEqual([]);
    const reading = Query.all(Position, Velocity).pipe(Query.changed(Position));
    expect(reading.readDefs).toEqual([Position, Velocity]);
    const byHand = {
      terms: [Position, Velocity] as const,
      withDefs: [],
      withoutDefs: [],
      changedDefs: [Position],
      readDefs: [Velocity, Position],
    };
    expect(world.view(byHand, "reader")).toBe(world.view(reading, "reader"));
    expect(() =>
      world.view({
        terms: [Position] as const,
        withDefs: [],
        withoutDefs: [],
        readDefs: [Velocity],
      })
    ).toThrow(
      /A query says it only reads "rd\/Velocity", which is not one of its terms: rd\/Position/
    );
    world.view(built[0]!, "reader").entities();
    expect(Object.keys(world.saveChanges()[0]!.readers)).toContain(
      "reader\nall(rd/Position,rd/Velocity) with(rd/Heat) without(rd/Boss) changed(rd/Position) added(rd/Heat) reads(rd/Velocity)"
    );
  });

  it("reads in a frozen world like any query", () => {
    const { world } = populated();
    world.freeze();
    let sum = 0;
    world.view(Moving).each((pos, vel) => {
      sum += pos.x + vel.x;
    });
    world.view(Looking).eachChunk((start, end, pos) => {
      for (let i = start; i < end; i++) {
        sum += pos.x[i]!;
      }
    });
    expect(sum).toBe(15 + 6 + 6);
    expect(() =>
      world.view(Moving).each((pos) => {
        pos.x = 1;
      })
    ).toThrow(/while the world is frozen/);
    world.thaw();
  });
});

// --- in an app --------------------------------------------------------------------

class TooFast extends Data.TaggedError("TooFast")<{}> {}
const Survey = Action.define("rd/Survey", Schema.Struct({ limit: Schema.Int }));
/** Looks at every body, changes one field of each, and may then refuse. */
const survey = Action.handler(Survey, function* ({ limit }) {
  let fastest = 0;
  (yield* Moving).eachChunk((start, end, pos, vel) => {
    for (let i = start; i < end; i++) {
      fastest = Math.max(fastest, vel.x[i]!);
      pos.y[i] = pos.y[i]! + 1;
    }
  });
  if (fastest > limit) {
    return yield* new TooFast();
  }
  return fastest;
});

describe("a query, which writes only what it names, in an app", () => {
  it("is what a system and a handler ask for, and a refusal still leaves nothing", () => {
    run(
      Effect.gen(function* () {
        const turned: number[] = [];
        const Move = System.make("Move", function* () {
          (yield* Moving).eachChunk((start, end, pos, vel) => {
            for (let i = start; i < end; i++) {
              pos.x[i] = pos.x[i]! + vel.x[i]!;
            }
          });
        });
        const Watch = System.make("Watch", function* () {
          turned.push((yield* Turned).entities().length);
        });
        const app = yield* App.make({
          systems: [Move, Watch],
          handlers: [survey],
          checkpointEvery: 1,
        });
        for (let n = 0; n < 4; n++) {
          app.world.spawn(
            Position.of({ x: n, y: 0 }),
            Velocity.of({ x: n, y: 0 })
          );
        }
        app.tick(1);
        app.tick(1);
        app.tick(1);
        // The system reads the velocities every tick, raw, and the one
        // that watches them is left in peace after its first look.
        expect(turned).toEqual([4, 0, 0]);
        const before = app.world.hash();
        expect(app.dispatch(Survey, { limit: 2 })).toEqual(
          Exit.fail(new TooFast())
        );
        expect(app.world.hash()).toBe(before);
        expect(app.dispatch(Survey, { limit: 5 })).toEqual(Exit.succeed(3));
        expect(app.world.hash()).not.toBe(before);
        app.tick(1);
        expect(turned.at(-1)).toBe(0);
      })
    );
  });
});
