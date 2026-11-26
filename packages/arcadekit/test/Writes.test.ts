import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Schema } from "effect";

import { idOf } from "../src/ecs/component.ts";
import { World as EcsWorld } from "../src/ecs/index.ts";
import type { ComponentDef } from "../src/ecs/index.ts";
import {
  Action,
  App,
  Commands,
  Component,
  EntityId,
  Event,
  Field,
  Plugin,
  Query,
  System,
  World,
} from "../src/index.ts";
import type { Entity } from "../src/index.ts";
import { thrown } from "./checks.ts";

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
    // One that hands out what it watches, to be written, doesn't compile.
    const Rewritten = Moved.pipe(Query.writes(Position));
    void (() =>
      // @ts-expect-error raw columns would count its own visit as a change
      world.view(Rewritten).eachChunk(() => {}));
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
    // Another component doesn't compile, whichever way it is given.
    void (() =>
      // @ts-expect-error Velocity is not one of the query's terms
      Query.all(Position).pipe(Query.writes(Velocity)));
    void (() =>
      // @ts-expect-error Velocity is not one of the query's terms
      Query.writes(Query.all(Position), Velocity));
    // One the compiler knows only as a component is refused when it is given.
    const unnamed: ComponentDef = Velocity;
    expect(() => Query.all(Position).pipe(Query.writes(unnamed))).toThrow(
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
      // Each watches what it writes, so it has no raw loop.
      void (() =>
        // @ts-expect-error raw columns would count its own visit as a change
        world.view(query, "anyone").eachChunk(() => {}));
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
    // Said in two steps, it writes both.
    const twice = Query.all(Position, Velocity).pipe(
      Query.changed(Position),
      Query.writes(Velocity),
      Query.writes(Position)
    );
    expect(twice.writeDefs).toEqual([Position, Velocity]);
    expect(twice.readDefs).toEqual([]);
    const reading = Query.all(Position, Velocity).pipe(Query.changed(Position));
    expect(reading.readDefs).toEqual([Position, Velocity]);
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

class TooFast extends Schema.TaggedError<TooFast>()("TooFast", {}) {}
const Survey = Action.define(
  "rd/Survey",
  Schema.Struct({ limit: Schema.Int }),
  { error: TooFast }
);
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
    return yield* TooFast.make({});
  }
  return fastest;
});

describe("a query, which writes only what it names, in an app", () => {
  it.effect(
    "is what a system and a handler ask for, and a refusal still leaves nothing",
    () =>
      Effect.gen(function* () {
        const turned: number[] = [];
        const Move = System.tick("Move", function* () {
          (yield* Moving).eachChunk((start, end, pos, vel) => {
            for (let i = start; i < end; i++) {
              pos.x[i] = pos.x[i]! + vel.x[i]!;
            }
          });
        });
        const Watch = System.tick("Watch", function* () {
          turned.push((yield* Turned).entities().length);
        });
        const Seed = Plugin.make("rd/Seed", {
          setup: Effect.gen(function* () {
            const commands = yield* Commands.spawns(Position, Velocity);
            for (let n = 0; n < 4; n++) {
              commands.spawn(
                Position.of({ x: n, y: 0 }),
                Velocity.of({ x: n, y: 0 })
              );
            }
          }),
        });
        const app = yield* App.make(
          App.define({
            plugins: [Seed],
            systems: [Move, Watch],
            handlers: [survey],
          }),
          { hashEvery: 1 }
        );
        const world = yield* app.read(World);
        yield* app.tick(1);
        yield* app.tick(1);
        yield* app.tick(1);
        // The system reads the velocities every tick, raw, and the one
        // that watches them is left in peace after its first look.
        expect(turned).toEqual([4, 0, 0]);
        const before = world.hash();
        expect(yield* Effect.exit(app.dispatch(Survey, { limit: 2 }))).toEqual(
          Exit.fail(TooFast.make({}))
        );
        expect(world.hash()).toBe(before);
        expect(yield* Effect.exit(app.dispatch(Survey, { limit: 5 }))).toEqual(
          Exit.succeed(3)
        );
        expect(world.hash()).not.toBe(before);
        yield* app.tick(1);
        expect(turned.at(-1)).toBe(0);
      })
  );
});

describe("a raw column a loop is handed read-only, in an app made with verifyFrames", () => {
  const Pointing = Component.relation("rd/Pointing", {
    onTargetDespawn: "remove",
  });
  const Bodies = Plugin.make("rd/Bodies", {
    setup: Effect.gen(function* () {
      const commands = yield* Commands.spawns(Position, Velocity, Pointing);
      const first = commands.spawn(
        Position.of({ x: 0, y: 0 }),
        Velocity.of({ x: 1, y: 2 })
      );
      commands.spawn(
        Position.of({ x: 1, y: 0 }),
        Velocity.of({ x: 1, y: 2 }),
        Pointing.of({ target: first })
      );
    }),
  });
  const Move = System.tick("Move", function* () {
    (yield* Moving).eachChunk((start, end, pos, vel) => {
      for (let i = start; i < end; i++) {
        pos.x[i] = pos.x[i]! + vel.x[i]!;
      }
    });
  });
  const Brake = System.tick("Brake", function* () {
    (yield* Moving).eachChunk((start, end, _, vel) => {
      for (let i = start; i < end; i++) {
        // @ts-expect-error Velocity is only read by this query
        vel.x[i] = 0;
      }
    });
  });
  const Turn = System.tick("Turn", function* () {
    (yield* Query.all(Pointing).pipe(Query.writes(Pointing))).eachChunk(
      (start, end, pointing) => {
        for (let i = start; i < end; i++) {
          // @ts-expect-error a relation's target is the world's to change
          pointing.target[i] = 99;
        }
      }
    );
  });
  const Halt = Action.define("rd/Halt", Schema.Struct({}));
  const halt = Action.handler(Halt, function* () {
    (yield* Moving).eachChunk((start, end, _, vel) => {
      for (let i = start; i < end; i++) {
        // @ts-expect-error Velocity is only read by this query
        vel.y[i] = 0;
      }
    });
  });
  /** Every field of every body, as a query that only reads finds them. */
  const bodies = (app: App.Any) =>
    app.read(
      Effect.map(Query.all(Position, Velocity, Pointing), (query) => {
        const values: number[] = [];
        query.each((pos, vel, pointing) => {
          values.push(pos.x, pos.y, vel.x, vel.y, idOf(pointing.target));
        });
        return values;
      })
    );
  const refusal = (field: string): Error =>
    new Error(
      `eachChunk() wrote "rd/Velocity.${field}", which the query only reads, through its raw column. No change query would see the write, and no refusal would undo it, so it has been put back. Name "rd/Velocity" in Query.writes to write it, or write it with each().`
    );

  it.effect("lets a loop write what its query writes", () =>
    Effect.gen(function* () {
      const app = yield* App.make(
        App.define({ plugins: [Bodies], systems: [Move] }),
        { verifyFrames: true }
      );
      yield* app.tick(1);
      yield* app.tick(1);
      expect((yield* bodies(app)).slice(0, 4)).toEqual([3, 0, 1, 2]);
    })
  );

  it.effect(
    "refuses a write to it in a tick, in a handler, and to a relation's target, and puts it back",
    () =>
      Effect.gen(function* () {
        const ticked = yield* App.make(
          App.define({ plugins: [Bodies], systems: [Brake] }),
          { verifyFrames: true }
        );
        const before = yield* bodies(ticked);
        expect(yield* thrown(ticked.tick(1))).toThrow(refusal("x"));
        expect(yield* bodies(ticked)).toEqual(before);

        const handled = yield* App.make(
          App.define({ plugins: [Bodies], handlers: [halt] }),
          { verifyFrames: true }
        );
        const unhalted = yield* bodies(handled);
        const exit = yield* Effect.exit(handled.dispatch(Halt, {}));
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(
          refusal("y")
        );
        expect(yield* bodies(handled)).toEqual(unhalted);

        const turned = yield* App.make(
          App.define({ plugins: [Bodies], systems: [Turn] }),
          { verifyFrames: true }
        );
        const unturned = yield* bodies(turned);
        expect(yield* thrown(turned.tick(1))).toThrow(
          /^eachChunk\(\) wrote the target of "rd\/Pointing" through its raw column, and it has been put back\. "rd\/Pointing" is a relation/
        );
        expect(yield* bodies(turned)).toEqual(unturned);
      })
  );

  it.effect("is not checked in an app made without it", () =>
    Effect.gen(function* () {
      const app = yield* App.make(
        App.define({ plugins: [Bodies], systems: [Brake] })
      );
      yield* app.tick(1);
      expect((yield* bodies(app)).slice(0, 4)).toEqual([1, 0, 0, 2]);
    })
  );
});

describe("an id Commands.spawn returns", () => {
  const Target = Component.relation("rd/Target", {
    onTargetDespawn: "remove",
  });
  const Fired = Event.define("rd/Fired", Schema.Struct({ shot: EntityId }));
  const Fire = Action.define("rd/Fire", Schema.Struct({}));

  it.effect("is not read before its entity is placed, and is once it is", () =>
    Effect.gen(function* () {
      const seen: (Entity | undefined)[] = [];
      const heard: Entity[] = [];
      const fire = Action.handler(Fire, function* () {
        const commands = yield* Commands.spawns(Position, Target);
        const world = yield* World;
        const shot = commands.spawn(Position.of({ x: 1, y: 0 }));
        // @ts-expect-error its entity is not placed until the handler ends
        world.get(shot, Position);
        // Commands, a component's value and an event's payload take it.
        commands.add(shot, Position.of({ x: 2, y: 0 }));
        commands.spawn(Position, Target.of({ target: shot }));
        (yield* Fired.emits).emit({ shot });
        seen.push(world.placed(shot));
        return shot;
      });
      const Hear = System.tick("rd/Hear", function* () {
        for (const { shot } of (yield* Fired).read()) {
          heard.push(shot);
        }
      });
      const app = yield* App.make(
        App.define({ handlers: [fire], systems: [Hear] })
      );
      const world = yield* app.read(World);
      const exit = yield* Effect.exit(app.dispatch(Fire, {}));
      // dispatch gives it back as an entity, once the handler has ended.
      const shot = Exit.isSuccess(exit) ? exit.value : undefined;
      expect(shot).toBeDefined();
      if (shot === undefined) {
        return;
      }
      expect(seen).toEqual([undefined]);
      expect(world.get(shot, Position)).toEqual({ x: 2, y: 0 });
      expect(world.sources(shot, Target)).toHaveLength(1);
      yield* app.tick(1 / 60);
      expect(heard).toEqual([shot]);
    })
  );
});
