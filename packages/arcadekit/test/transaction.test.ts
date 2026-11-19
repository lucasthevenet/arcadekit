import { Cause, Data, Effect, Exit, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  Action,
  App,
  CommandBuffer,
  Commands,
  Component,
  EcsWorld,
  EntityId,
  Event,
  Field,
  Query,
  Random,
  System,
  Time,
  World,
} from "../src/index";
import type { Entity } from "../src/index";

// One component of every field kind, in a table and in a sparse set.
const kinds = {
  single: Field.f32,
  double: Field.f64,
  signed: Field.i32,
  unsigned: Field.u32,
  short: Field.u16,
  byte: Field.u8,
  other: Field.entity,
  note: Field.json<unknown>(),
};

const Body = Component.define("tx/Body", { x: Field.f32, y: Field.f32 });
const Sheet = Component.define("tx/Sheet", kinds);
const Aura = Component.define("tx/Aura", kinds, { storage: "sparse" });
const Marked = Component.tag("tx/Marked");
const Chilled = Component.tag("tx/Chilled", { storage: "sparse" });

const sheet = (n: number) => ({
  single: n + 0.5,
  double: n + 0.25,
  signed: -n,
  unsigned: 3_000_000_000 + n,
  short: 60_000 + n,
  byte: 200 + (n % 50),
  other: n as Entity,
  note: `note ${n}` as unknown,
});

// Two singletons: one the populated world has written, one it has not.
const Clock = Component.singleton("tx/Clock", kinds, sheet(500));

const Mood = Component.singleton(
  "tx/Mood",
  { level: Field.i32, word: Field.json<string>() },
  { level: 3, word: "calm" }
);

const Bodies = Query.all(Body);
const Sheets = Query.all(Sheet);
const Auras = Query.all(Aura);
const Both = Query.all(Body, Aura).pipe(Query.without(Chilled));

/** A world with a few tables, some sparse members and some freed slots. */
const populated = (): { world: EcsWorld; entities: Entity[] } => {
  const world = new EcsWorld({ seed: 12 });
  const entities: Entity[] = [];

  for (let n = 0; n < 24; n += 1) {
    const entity = world.spawn(Body.of({ x: n, y: -n }));

    if (n % 2 === 0) {
      world.add(entity, Sheet.of(sheet(n)));
    }

    if (n % 3 === 0) {
      world.add(entity, Aura.of(sheet(n + 100)));
    }

    if (n % 5 === 0) {
      world.add(entity, Marked);
    }

    if (n % 7 === 0) {
      world.add(entity, Chilled);
    }

    entities.push(entity);
  }

  world.despawn(entities.splice(20, 1)[0]!);
  world.despawn(entities.splice(4, 1)[0]!);
  world.singleton(Clock).signed = -1;

  return { world, entities };
};

/** Every way plain code can write to component data. */
const writers: Record<string, (world: EcsWorld, entities: Entity[]) => void> = {
  "set on a table component": (world, entities) => {
    world.set(entities[0]!, Body, { x: 99 });
    world.set(entities[0]!, Sheet, sheet(77));
  },
  "set on a sparse component": (world, entities) => {
    world.set(entities[0]!, Aura, sheet(78));
  },
  "set twice on one row": (world, entities) => {
    world.set(entities[1]!, Body, { x: 1 });
    world.set(entities[1]!, Body, { x: 2, y: 3 });
  },
  "each over table components": (world) => {
    world.view(Bodies).each((body) => {
      body.x += 1;
      body.y *= 2;
    });
    world.view(Sheets).each((row) => {
      row.single = 0;
      row.double = 0;
      row.signed = 1;
      row.unsigned = 1;
      row.short = 1;
      row.byte = 1;
      row.other = 0 as Entity;
      row.note = "rewritten";
    });
  },
  "each over a sparse component": (world) => {
    world.view(Auras).each((aura) => {
      aura.single += 1;
      aura.note = undefined;
    });
  },
  "each over a table and a sparse component, with a filter": (world) => {
    world.view(Both).each((body, aura) => {
      body.x = -1;
      aura.byte = 9;
    });
  },
  "eachChunk over raw columns": (world) => {
    world.view(Bodies).eachChunk((start, end, body) => {
      for (let i = start; i < end; i += 1) {
        body.x[i] = 5;
        body.y[i] = body.y[i]! + 5;
      }
    });
    world.view(Sheets).eachChunk((start, end, row) => {
      for (let i = start; i < end; i += 1) {
        row.double[i] = 1e9;
        row.note[i] = { replaced: true };
      }
    });
  },
  "eachChunk over a sparse component's columns": (world) => {
    world.view(Both).eachChunk((start, end, body, aura, ids) => {
      for (let i = start; i < end; i += 1) {
        body.y[i] = 0;
        aura.columns.signed[aura.indexOf(ids[i]!)] = 123;
      }
    });
  },
  "a row, then its whole column, then the row again": (world, entities) => {
    world.set(entities[2]!, Body, { x: 10 });
    world.view(Bodies).each((body) => {
      body.x += 100;
    });
    world.set(entities[2]!, Body, { x: 20 });
  },
  "a loop nested in a loop": (world) => {
    world.view(Bodies).each((outer) => {
      world.view(Bodies).each((inner) => {
        inner.y += outer.x;
      });
    });
  },
  "writing a singleton that was written before": (world) => {
    const clock = world.singleton(Clock);
    clock.single += 1;
    clock.note = { replaced: true };
    clock.other = 9 as Entity;
  },
  "writing a singleton for the first time": (world) => {
    const mood = world.singleton(Mood);
    mood.level = mood.level + 1;
    mood.word = "stormy";
  },
  "drawing random numbers": (world) => {
    world.random.next();
    world.random.shuffle([1, 2, 3, 4]);
  },
};

describe("a transaction of a world", () => {
  for (const [name, write] of Object.entries(writers)) {
    it(`takes back ${name} on rollback, and keeps it on commit`, () => {
      const { entities, world } = populated();
      const before = world.hash();

      const values = entities.map((entity) => [
        world.get(entity, Body),
        world.get(entity, Sheet),
        world.get(entity, Aura),
      ]);

      world.begin();
      write(world, entities);
      // Inside the transaction the writes are there to be read.
      expect(world.hash()).not.toBe(before);
      world.rollback();
      expect(world.hash()).toBe(before);
      expect(
        entities.map((entity) => [
          world.get(entity, Body),
          world.get(entity, Sheet),
          world.get(entity, Aura),
        ])
      ).toEqual(values);

      world.begin();
      write(world, entities);
      const written = world.hash();
      world.commit();
      expect(world.hash()).toBe(written);
      expect(written).not.toBe(before);

      // And with no transaction nothing is saved or taken back.
      const again = populated();
      write(again.world, again.entities);
      expect(again.world.hash()).toBe(written);
    });
  }

  it("takes back every writer at once, in any order", () => {
    const names = Object.keys(writers);
    const dice = new EcsWorld({ seed: 5 }).random;

    for (let round = 0; round < 30; round += 1) {
      const { entities, world } = populated();
      const before = world.hash();
      world.begin();

      for (const name of dice.shuffle([...names])) {
        writers[name]!(world, entities);
      }

      world.rollback();
      expect(world.hash()).toBe(before);
    }
  });

  it("takes writes back transaction after transaction, as tables grow and shrink between them", () => {
    // The copies of one transaction are kept and written over by the next,
    // so each must hold this transaction's rows and no stale ones.
    const { entities, world } = populated();
    const dice = new EcsWorld({ seed: 8 }).random;

    for (let round = 0; round < 40; round += 1) {
      if (round % 3 === 0) {
        // Past the room the tables had when their columns were last saved.
        for (let n = 0; n < 30; n += 1) {
          const entity = world.spawn(Body.of({ x: n, y: round }));
          world.add(entity, Sheet.of(sheet(n + round)));
          world.add(entity, Aura.of(sheet(n)));
          entities.push(entity);
        }
      } else {
        for (let n = 0; n < 12 && entities.length > 6; n += 1) {
          world.despawn(
            entities.splice(dice.int(3, entities.length - 1), 1)[0]!
          );
        }
      }

      const before = world.hash();
      world.begin();

      for (const write of Object.values(writers)) {
        write(world, entities);
      }

      if (round % 4 === 3) {
        world.commit();
        expect(world.hash()).not.toBe(before);
      } else {
        world.rollback();
        expect(world.hash()).toBe(before);
      }
    }
  });

  it("refuses to change which entities exist, and says where such a change goes", () => {
    const { entities, world } = populated();
    const before = world.hash();
    world.begin();

    const refusals = [
      () => world.spawn(Body),
      () => world.despawn(entities[0]!),
      () => world.add(entities[0]!, Marked),
      () => world.add(entities[0]!, Chilled),
      () => world.remove(entities[0]!, Body),
      () => world.remove(entities[0]!, Aura),
    ];

    for (const refusal of refusals) {
      expect(refusal).toThrow(
        /was called inside a transaction.*Queue it on Commands/u
      );
    }

    expect(() => world.spawn(Body)).toThrow(/World\.spawn\(\)/u);
    expect(() => world.remove(entities[0]!, Body)).toThrow(
      /World\.remove\(\)/u
    );
    world.rollback();
    expect(world.hash()).toBe(before);
    // Outside one they work as ever.
    expect(world.isAlive(world.spawn(Body))).toBe(true);
    expect(world.despawn(entities[0]!)).toBe(true);
  });

  it("is one at a time, and has to be begun before it is ended", () => {
    const world = new EcsWorld();
    expect(() => world.commit()).toThrow(
      /World\.commit\(\) was called with no transaction/u
    );
    expect(() => world.rollback()).toThrow(
      /World\.rollback\(\) was called with no transaction/u
    );
    world.begin();
    expect(() => world.begin()).toThrow(/inside a transaction/u);
    world.commit();
    expect(() => world.commit()).toThrow(/no transaction/u);
    world.begin();
    world.rollback();
    expect(() => world.rollback()).toThrow(/no transaction/u);
  });

  it("starts each transaction from what the last one left", () => {
    const { entities, world } = populated();
    const [first] = entities;
    world.begin();
    world.set(first!, Body, { x: 1 });
    world.commit();
    const kept = world.hash();
    world.begin();
    world.set(first!, Body, { x: 2 });
    world.view(Bodies).each((body) => {
      body.y = 0;
    });
    world.rollback();
    // Back to the committed write, not to the world before both.
    expect(world.get(first!, Body)!.x).toBe(1);
    expect(world.hash()).toBe(kept);
    world.begin();
    world.rollback();
    expect(world.hash()).toBe(kept);
  });

  it("puts a replaced object back, but not an object changed in place", () => {
    const world = new EcsWorld();
    const held = { hp: 1 };
    const entity = world.spawn(Sheet.of({ ...sheet(1), note: held }));
    world.begin();
    world.set(entity, Sheet, { note: { hp: 99 } });
    world.rollback();
    expect(world.get(entity, Sheet)!.note).toBe(held);

    world.begin();
    (world.get(entity, Sheet)!.note as { hp: number }).hp = 50;
    world.rollback();
    // The field holds the same object as before, and the object was changed.
    expect(world.get(entity, Sheet)!.note).toBe(held);
    expect(held.hp).toBe(50);
  });

  it("leaves reads alone: nothing is saved for a count, a lookup or a hash", () => {
    const { entities, world } = populated();
    const before = world.hash();
    world.begin();
    world.view(Bodies).count();
    world.view(Bodies).entities();
    world.get(entities[0]!, Sheet);
    world.has(entities[0]!, Aura);
    world.hash();
    world.rollback();
    expect(world.hash()).toBe(before);
  });
});

describe("commands that are rolled back", () => {
  it("give their reserved ids back exactly, so the next entities get the ids they would have", () => {
    const { world } = populated();
    const before = world.hash();

    const ids = (): Entity[] => {
      const probe = populated().world;

      return [probe.spawn(), probe.spawn(), probe.spawn(), probe.spawn()];
    };

    const expected = ids();

    const commands = new CommandBuffer(world);
    const mark = commands.mark();

    // Two slots were freed in this world: these four reserve both of them
    // and then two indices that have never been used.
    const reserved = [
      commands.spawn(Body),
      commands.spawn(Body, Marked),
      commands.spawn(),
      commands.spawn(Aura),
    ];

    expect(reserved).toEqual(expected);
    expect(world.hash()).not.toBe(before);
    commands.rollback(mark);
    expect(commands.size).toBe(0);
    expect(world.hash()).toBe(before);
    expect(reserved.some((entity) => world.isAlive(entity))).toBe(false);
    expect([
      world.spawn(),
      world.spawn(),
      world.spawn(),
      world.spawn(),
    ]).toEqual(expected);
  });

  it("keep the commands queued before the mark, and their ids", () => {
    const world = new EcsWorld();
    const commands = new CommandBuffer(world);
    const kept = commands.spawn(Body.of({ x: 1, y: 1 }));
    const mark = commands.mark();
    const dropped = commands.spawn(Body.of({ x: 2, y: 2 }));
    commands.despawn(kept);
    commands.rollback(mark);
    expect(commands.size).toBe(1);
    commands.apply();
    expect(world.isAlive(kept)).toBe(true);
    expect(world.isAlive(dropped)).toBe(false);
    expect(world.get(kept, Body)).toEqual({ x: 1, y: 1 });
    // The dropped id is the next one handed out, as if it had not been asked for.
    expect(world.spawn()).toBe(dropped);
  });

  it("still free the slot when something else was spawned in between", () => {
    const world = new EcsWorld();
    const commands = new CommandBuffer(world);
    const mark = commands.mark();
    const queued = commands.spawn(Body);
    const direct = world.spawn(Body);
    commands.rollback(mark);
    expect(world.isAlive(queued)).toBe(false);
    expect(world.isAlive(direct)).toBe(true);
    expect(world.entityCount).toBe(1);
    // Not exact here, and it cannot be: the slot is reused under a new generation.
    const next = world.spawn(Body);
    expect(next).not.toBe(queued);
    expect(world.isAlive(next)).toBe(true);
  });
});

// --- through an app: an action that is refused leaves nothing behind ------------

class Refused extends Data.TaggedError("Refused")<{}> {}

const Noted = Event.define<{ readonly step: string }>("tx/Noted");

/** Emitted by a system every tick, for a handler to read. */
const Rung = Event.define("tx/Rung", Schema.Struct({ at: Schema.Int }));

const Step = Schema.Literals([
  "set",
  "each",
  "chunk",
  "sparse",
  "draw",
  "spawn",
  "despawn",
  "add",
  "remove",
  "emit",
  "enqueue",
  "read",
  "ring",
  "bug",
]);

const Act = Action.define(
  "tx/Act",
  Schema.Struct({
    target: EntityId,
    steps: Schema.Array(Step),
    refuse: Schema.Boolean,
  })
);

const Echo = Action.define("tx/Echo", Schema.Struct({ by: Schema.Int }));

/** Does whatever it is told, in order, and only then decides to refuse. */
const act = Action.handler(Act, function* ({ refuse, steps, target }) {
  const world = yield* World;
  const commands = yield* Commands;
  const random = yield* Random;
  const noted = yield* Noted;
  const actions = yield* Action.Actions;

  for (const step of steps) {
    switch (step) {
      case "set": {
        world.set(target, Body, { x: random.int(1, 1000) });
        break;
      }

      case "each": {
        (yield* Bodies).each((body) => {
          body.y += 1;
        });
        break;
      }

      case "chunk": {
        (yield* Sheets).eachChunk((start, end, row) => {
          for (let i = start; i < end; i += 1) {
            row.signed[i] = row.signed[i]! - 1;
            row.note[i] = `seen ${row.signed[i]}`;
          }
        });
        break;
      }

      case "sparse": {
        (yield* Auras).each((aura) => {
          aura.double += 0.5;
        });
        break;
      }

      case "draw": {
        random.next();
        break;
      }

      case "spawn": {
        commands.spawn(Body.of({ x: 0, y: random.next() }), Sheet.of(sheet(3)));
        break;
      }

      case "despawn": {
        commands.despawn(target);
        break;
      }

      case "add": {
        commands.add(target, Aura.of(sheet(random.int(1, 50))));
        commands.add(target, Marked);
        break;
      }

      case "remove": {
        commands.remove(target, Sheet);
        commands.remove(target, Chilled);
        break;
      }

      case "emit": {
        noted.emit({ step });
        break;
      }

      case "enqueue": {
        actions.enqueue(Echo, { by: 1 });
        break;
      }

      case "read": {
        // What it has heard since it last listened goes into the world, so
        // that an event read twice, or never, shows.
        const heard = (yield* Rung)
          .read()
          .reduce((sum, { at }) => sum + 100 + at, 0);

        (yield* Bodies).each((body) => {
          body.y += heard;
        });
        break;
      }

      case "ring": {
        // An event of the kind it reads, so that it can read twice.
        (yield* Rung).emit({ at: 0 });
        break;
      }

      case "bug": {
        throw new Error("a bug in the handler");
      }
    }
  }

  if (refuse) {
    return yield* Effect.fail(new Refused());
  }

  return steps.length;
});

const echoes: number[] = [];

const echo = Action.handler(Echo, function* ({ by }) {
  echoes.push(by);
  (yield* Bodies).each((body) => {
    body.x += by;
  });
});

const notes: string[] = [];

const Listen = System.make("Listen", function* () {
  for (const { step } of (yield* Noted).read()) {
    notes.push(step);
  }
});

const Ring = System.make("Ring", function* () {
  (yield* Rung).emit({ at: (yield* Time).tick });
});

/** Hears each ring in the tick it is rung in: once, whatever is refused. */
const rings: number[] = [];

const Hear = System.make("Hear", function* () {
  for (const { at } of (yield* Rung).read()) {
    rings.push(at);
  }
});

const withApp = <T, A>(
  make: Effect.Effect<T, never, Scope.Scope>,
  use: (app: T) => A
): A => Effect.runSync(Effect.scoped(Effect.map(make, use)));

const game = (checkpointEvery = 1) =>
  Effect.map(
    App.make({
      systems: [Listen, Ring, Hear],
      handlers: [act, echo],
      seed: 9,
      checkpointEvery,
    }),
    (app) => {
      const entities: Entity[] = [];

      for (let n = 0; n < 12; n += 1) {
        const entity = app.world.spawn(
          Body.of({ x: n, y: n }),
          Sheet.of(sheet(n))
        );

        if (n % 2 === 0) {
          app.world.add(entity, Aura.of(sheet(n)));
        }

        if (n % 3 === 0) {
          app.world.add(entity, Chilled);
        }

        entities.push(entity);
      }

      // Two freed slots, so a spawn reuses one before it takes a fresh index.
      app.world.despawn(entities.splice(7, 1)[0]!);
      app.world.despawn(entities.splice(2, 1)[0]!);

      return { app, entities };
    }
  );

type Steps = (typeof Step.Type)[];

const everyStep: Steps = [
  "set",
  "each",
  "chunk",
  "sparse",
  "draw",
  "spawn",
  "despawn",
  "add",
  "remove",
  "emit",
  "enqueue",
  "read",
];

describe("an action that is refused", () => {
  for (const step of everyStep) {
    it(`leaves nothing behind after "${step}"`, () => {
      withApp(game(), ({ app, entities }) => {
        echoes.length = 0;
        notes.length = 0;
        app.tick(1);
        const before = app.world.hash();
        const log = app.actionLog.length;

        const exit = app.dispatch(Act, {
          target: entities[0]!,
          steps: [step],
          refuse: true,
        });

        expect(exit).toEqual(Exit.fail(new Refused()));
        expect(app.world.hash()).toBe(before);
        expect(app.commands.size).toBe(0);
        expect(app.events.pending(Noted)).toBe(0);
        expect(app.actionLog).toHaveLength(log);
        // Nor does it show up later: no queued action, no event, no entity.
        app.tick(1);
        expect(echoes).toEqual([]);
        expect(notes).toEqual([]);
        expect(app.world.hash()).toBe(before);

        // The same steps in an action that is accepted do change the game.
        const accepted = app.dispatch(Act, {
          target: entities[0]!,
          steps: [step],
          refuse: false,
        });

        expect(accepted).toEqual(Exit.succeed(1));
        app.tick(1);
        app.tick(1);

        const changed =
          app.world.hash() !== before || notes.length > 0 || echoes.length > 0;

        expect(changed).toBe(true);
      });
    });
  }

  it("leaves nothing behind when its handler dies of a bug half-way", () => {
    withApp(game(), ({ app, entities }) => {
      const before = app.world.hash();

      const exit = app.dispatch(Act, {
        target: entities[0]!,
        steps: [...everyStep, "bug"],
        refuse: false,
      });

      expect(Exit.isFailure(exit)).toBe(true);
      expect(app.world.hash()).toBe(before);
      expect(app.commands.size).toBe(0);
      expect(app.events.pending(Noted)).toBe(0);
      // And the app goes on: the next action runs in a transaction of its own.
      expect(
        app.dispatch(Act, {
          target: entities[0]!,
          steps: ["set"],
          refuse: false,
        })
      ).toEqual(Exit.succeed(1));
    });
  });

  it("leaves nothing behind when it was queued and is refused at the start of a tick", () => {
    withApp(game(), ({ app, entities }) => {
      echoes.length = 0;
      const before = app.world.hash();
      // Three queued actions: the refused one in the middle enqueues another
      // and dirties everything, and neither of its neighbours is disturbed.
      app.enqueue(Echo, { by: 2 });
      app.enqueue(Act, {
        target: entities[0]!,
        steps: everyStep,
        refuse: true,
      });
      app.enqueue(Echo, { by: 3 });
      app.tick(1);
      expect(echoes).toEqual([2, 3]);
      const after = app.world.hash();
      expect(after).not.toBe(before);
      app.tick(1);
      expect(echoes).toEqual([2, 3]);
      expect(app.world.hash()).toBe(after);

      // The same two actions with nothing between them give the same world.
      const plain = withApp(game(), (other) => {
        other.app.enqueue(Echo, { by: 2 });
        other.app.enqueue(Echo, { by: 3 });
        other.app.tick(1);

        return other.app.world.hash();
      });

      expect(after).toBe(plain);
    });
  });

  it("has not read the events its handler read: the next action hears them", () => {
    const heardBy = (attempts: readonly ("refused" | "queued")[]) =>
      withApp(game(), ({ app, entities }) => {
        const target = entities[0]!;
        const y = (): number => app.world.get(target, Body)!.y;
        const before = y();
        app.tick(1);

        for (const attempt of attempts) {
          const payload = { target, steps: ["read" as const], refuse: true };

          if (attempt === "refused") {
            expect(app.dispatch(Act, payload)).toEqual(
              Exit.fail(new Refused())
            );
          } else {
            // Refused when its turn comes, at the start of the next tick.
            app.enqueue(Act, payload);
            app.tick(1);
          }

          expect(y()).toBe(before);
        }

        app.dispatch(Act, { target, steps: ["read"], refuse: false });
        const heard = y() - before;
        // And what was read by an action that was accepted stays read.
        app.dispatch(Act, { target, steps: ["read"], refuse: false });
        expect(y() - before).toBe(heard);

        return heard;
      });

    // The event of tick 1, whether or not anything was refused before.
    expect(heardBy([])).toBe(101);
    expect(heardBy(["refused"])).toBe(101);
    expect(heardBy(["refused", "refused", "refused"])).toBe(101);

    // After a refusal that took a tick: the events of ticks 1 and 2.
    const afterATick = withApp(game(), ({ app, entities }) => {
      const target = entities[0]!;
      const before = app.world.get(target, Body)!.y;
      app.tick(1);
      app.tick(1);
      app.dispatch(Act, { target, steps: ["read"], refuse: false });

      return app.world.get(target, Body)!.y - before;
    });

    expect(heardBy(["queued"])).toBe(afterATick);
  });

  it("unreads only what its own handler read, however often it read", () => {
    withApp(game(), ({ app, entities }) => {
      const target = entities[0]!;
      const y = (): number => app.world.get(target, Body)!.y;

      const act = (steps: Steps, refuse: boolean): void => {
        app.dispatch(Act, { target, steps, refuse });
      };

      rings.length = 0;
      app.tick(1);
      const before = y();
      // Reads, rings and reads again, and is refused: both reads are undone.
      act(["read", "ring", "read"], true);
      expect(y()).toBe(before);
      act(["read"], false);
      expect(y() - before).toBe(101);
      // What an accepted action read stays read through a later refusal.
      act(["set"], true);
      act(["read"], true);
      act(["read"], false);
      expect(y() - before).toBe(101);
      // And a system's reads are no action's to take back: it hears each
      // ring once, with refusals and acceptances between its ticks.
      app.tick(1);
      act(["read"], true);
      app.tick(1);
      act(["read"], false);
      act(["emit"], true);
      app.tick(1);
      app.enqueue(Act, { target, steps: ["read"], refuse: true });
      app.tick(1);
      expect(rings).toEqual([1, 2, 3, 4, 5]);
    });
  });

  it("replays when the refused action had read events, as if it had not", () => {
    const { hash, log } = withApp(game(), ({ app, entities }) => {
      const target = entities[0]!;
      app.tick(1);
      app.dispatch(Act, { target, steps: ["read"], refuse: true });
      app.dispatch(Act, { target, steps: ["read"], refuse: false });
      app.tick(1);
      app.dispatch(Act, { target, steps: ["emit", "read"], refuse: true });
      app.enqueue(Act, { target, steps: ["read"], refuse: true });
      app.enqueue(Act, { target, steps: ["read"], refuse: false });
      app.tick(1);

      return { log: [...app.actionLog], hash: app.world.hash() };
    });

    const replayed = withApp(game(), ({ app }) => {
      App.replay(app, log, { delta: 1, ticks: 3 });

      return app.world.hash();
    });

    expect(replayed).toBe(hash);
  });

  it("gives the same ids afterwards as if it had never been dispatched", () => {
    const next = (dirty: boolean) =>
      withApp(game(), ({ app, entities }) => {
        if (dirty) {
          app.dispatch(Act, {
            target: entities[0]!,
            steps: ["spawn", "spawn", "spawn", "despawn"],
            refuse: true,
          });
        }

        return [app.world.spawn(), app.world.spawn(), app.world.spawn()];
      });

    expect(next(true)).toEqual(next(false));
  });
});

describe("an action that is accepted", () => {
  it("keeps what it wrote, and reads its own writes while it runs", () => {
    const Twice = Action.define(
      "tx/Twice",
      Schema.Struct({ target: EntityId })
    );

    const twice = Action.handler(Twice, function* ({ target }) {
      const world = yield* World;
      world.set(target, Body, { x: 10 });
      const seen = world.get(target, Body)!.x;
      world.set(target, Body, { x: seen * 2 });
      let total = 0;
      (yield* Bodies).each((body) => {
        body.y = 1;
      });
      (yield* Bodies).each((body) => {
        total += body.y;
      });

      return [world.get(target, Body)!.x, total] as const;
    });

    withApp(App.make({ handlers: [twice] }), (app) => {
      const target = app.world.spawn(Body.of({ x: 1, y: 5 }));
      app.world.spawn(Body.of({ x: 1, y: 5 }));
      expect(app.dispatch(Twice, { target })).toEqual(Exit.succeed([20, 2]));
      expect(app.world.get(target, Body)).toEqual({ x: 20, y: 1 });
    });
  });

  it("changes which entities exist through Commands: a direct change is a bug, and is undone like one", () => {
    const Direct = Action.define(
      "tx/Direct",
      Schema.Struct({
        target: EntityId,
        how: Schema.Literals(["world", "commands"]),
      })
    );

    const direct = Action.handler(Direct, function* ({ how, target }) {
      const world = yield* World;
      world.set(target, Body, { x: 42 });

      if (how === "world") {
        world.despawn(target);
      } else {
        (yield* Commands).despawn(target);
      }
    });

    withApp(App.make({ handlers: [direct] }), (app) => {
      const target = app.world.spawn(Body.of({ x: 1, y: 1 }));
      const before = app.world.hash();
      const exit = app.dispatch(Direct, { target, how: "world" });
      expect(Exit.isFailure(exit)).toBe(true);
      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toMatch(
        /World\.despawn\(\) was called inside a transaction/u
      );
      expect(app.world.hash()).toBe(before);
      expect(app.world.get(target, Body)).toEqual({ x: 1, y: 1 });

      expect(
        Exit.isSuccess(app.dispatch(Direct, { target, how: "commands" }))
      ).toBe(true);
      expect(app.world.isAlive(target)).toBe(false);
    });
  });

  it("cannot dispatch another action from its handler, and is told what to do instead", () => {
    const Outer = Action.define("tx/Outer", Schema.Struct({}));
    let app: App.Any | undefined;

    const outer = Action.handler(Outer, function* () {
      (yield* Bodies).each((body) => {
        body.x = 7;
      });
      app!.dispatchByName("tx/Echo", { by: 1 });
    });

    withApp(App.make({ handlers: [outer, echo] }), (made) => {
      app = made;
      const entity = made.world.spawn(Body.of({ x: 1, y: 1 }));
      const exit = made.dispatch(Outer, {});
      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toMatch(
        /dispatch\("tx\/Echo"\) was called from the handler of "tx\/Outer".*Actions\.enqueue/u
      );
      expect(made.world.get(entity, Body)).toEqual({ x: 1, y: 1 });
      // The world is out of its transaction: the next dispatch works.
      expect(Exit.isSuccess(made.dispatchByName("tx/Echo", { by: 1 }))).toBe(
        true
      );
    });
  });
});

describe("a game full of refused actions", () => {
  it("replays from its log, checkpoint by checkpoint, as if they had never been tried", () => {
    // Refused actions are not in the log, so a replay never runs them. If one
    // of them left anything in the world, the replay's hash would differ at
    // the next checkpoint. Random steps, random targets, half of them refused.
    const steps = everyStep;

    for (const seed of [1, 2, 3]) {
      const recorded = withApp(game(), ({ app, entities }) => {
        const dice = new EcsWorld({ seed }).random;
        let refusedCount = 0;

        for (let tick = 0; tick < 60; tick += 1) {
          for (let n = dice.int(0, 3); n > 0; n -= 1) {
            const chosen = Array.from({ length: dice.int(1, 6) }, () =>
              dice.pick(steps)
            );

            const refuse = dice.int(0, 1) === 1;

            const payload = {
              target: dice.pick(entities),
              steps: chosen,
              refuse,
            };

            if (dice.int(0, 2) === 0) {
              app.enqueue(Act, payload);
            } else {
              app.dispatch(Act, payload);
            }

            refusedCount += refuse ? 1 : 0;
          }

          app.tick(1 / 60);
        }

        return {
          log: [...app.actionLog],
          refusedCount,
          hash: app.world.hash(),
        };
      });

      expect(recorded.refusedCount).toBeGreaterThan(20);

      const replayed = withApp(game(), ({ app }) => {
        App.replay(app, recorded.log, { delta: 1 / 60, ticks: 60 });

        return app.world.hash();
      });

      expect(replayed).toBe(recorded.hash);
    }
  });
});
