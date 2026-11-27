import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema, Tracer } from "effect";

import type { Spawned } from "../src/index.ts";
import {
  Action,
  App,
  Commands,
  Component,
  Event,
  Field,
  Plugin,
  Query,
  Singleton,
  State,
  System,
  Timeline,
  World,
} from "../src/index.ts";
import { thrown } from "./checks.ts";
import { placedIn } from "./placed.ts";

const Position = Component.define("in/Position", {
  x: Field.f64,
  y: Field.f64,
});
const Heat = Component.define(
  "in/Heat",
  { degrees: Field.f32 },
  { storage: "sparse" }
);
const Boss = Component.tag("in/Boss");
const Name = Component.define("in/Name", { text: Field.json<string>("") });
const ChildOf = Component.relation("in/ChildOf", {
  onTargetDespawn: "despawn",
});
const Score = Singleton.define(
  "in/Score",
  { points: Field.i32 },
  { points: 0 }
);
const Phase = State.define("in/Phase", ["title", "playing"]);

const Hit = Event.define("in/Hit", Schema.Struct({ by: Schema.Int }));
const Spawned = Event.define("in/Spawned", Schema.Struct({}));
const Strike = Action.define("in/Strike", Schema.Struct({ by: Schema.Int }));
const Begin = Action.define("in/Begin", Schema.Struct({}));
class NotNow extends Schema.TaggedError<NotNow>()("in/NotNow", {}) {}
const Refuse = Action.define("in/Refuse", Schema.Struct({}), {
  error: NotNow,
});

const Moved = Query.all(Position).pipe(Query.writes(Position));
const Move = System.tick("in/Move", function* () {
  (yield* Moved).each((position) => {
    position.x += 1;
  });
});
const Scorer = System.tick("in/Scorer", function* () {
  const hits = (yield* Hit).read();
  for (const { by } of hits) {
    (yield* Score.writes).points += by;
  }
});
const Asleep = System.tick("in/Asleep", function* () {}).pipe(
  System.runIf(Effect.succeed(false))
);
const Opening = State.onEnter(Phase, "playing", "in/Opening", function* () {
  (yield* Spawned.emits).emit({});
});
const Draw = System.frame("in/Draw", function* () {});
const Read = System.input("in/Read", function* () {});

const handlers = [
  Action.handler(Strike, function* ({ by }) {
    (yield* Hit.emits).emit({ by });
  }),
  Action.handler(Begin, function* () {
    (yield* Phase.sets).set("playing");
  }),
  Action.handler(Refuse, function* () {
    (yield* Hit.emits).emit({ by: 1000 });
    return yield* NotNow.make({});
  }),
] as const;

const game = App.make(
  App.define({ systems: [Draw, Read, Move, Scorer, Asleep, Opening], handlers })
);

const worldOf = (app: Pick<App.Any, "read">) => app.read(World);

describe("app.inspect", () => {
  it.effect(
    "copies every live entity, in order, with its components by name, sparse ones and tags included",
    () =>
      Effect.gen(function* () {
        const ids: Spawned[] = [];
        const Seed = Plugin.make("in/Seed", {
          setup: Effect.gen(function* () {
            const commands = yield* Commands.spawns(
              Position,
              Boss,
              Name,
              Heat,
              ChildOf
            );
            const parent = commands.spawn(
              Position.of({ x: 1, y: 2 }),
              Boss,
              Name.of({ text: "boss" })
            );
            const gone = commands.spawn(Position.of({ x: 9, y: 9 }));
            const child = commands.spawn(
              Position.of({ x: 3, y: 4 }),
              Heat.of({ degrees: 40 }),
              ChildOf.of({ target: parent })
            );
            const bare = commands.spawn();
            commands.despawn(gone);
            ids.push(parent, child, bare);
          }),
        });
        const app = yield* App.make(App.define({ plugins: [Seed] }));
        const world = yield* worldOf(app);
        const [parent, child, bare] = ids.map((id) => placedIn(world, id));

        const { entities } = yield* app.inspect();
        expect(entities).toEqual([
          {
            id: parent,
            components: {
              "in/Boss": {},
              "in/Name": { text: "boss" },
              "in/Position": { x: 1, y: 2 },
            },
          },
          {
            id: child,
            components: {
              "in/ChildOf": { target: parent },
              "in/Position": { x: 3, y: 4 },
              "in/Heat": { degrees: 40 },
            },
          },
          { id: bare, components: {} },
        ]);
      })
  );

  it.effect("copies every singleton the world holds, by name", () =>
    Effect.gen(function* () {
      const app = yield* game;
      yield* app.enqueue(Strike, { by: 7 });
      yield* app.tick(1 / 60);
      expect((yield* app.inspect()).singletons["in/Score"]).toEqual({
        points: 7,
      });
    })
  );

  it.effect(
    "shows the actions queued for the next tick and the events waiting to be read, as plain data",
    () =>
      Effect.gen(function* () {
        const app = yield* game;
        expect((yield* app.inspect()).stores).toEqual({});
        yield* app.dispatch(Strike, { by: 5 });
        yield* app.enqueue(Strike, { by: 6 });
        const world = yield* worldOf(app);
        const hash = world.hash();
        const { stores } = yield* app.inspect();
        expect(stores).toEqual({
          [Action.INTAKE]: {
            queued: [{ name: "in/Strike", payload: { by: 6 }, from: null }],
          },
          [Event.STORE]: { "in/Hit": [{ by: 5 }] },
        });
        // Copies: writing them changes nothing of the game.
        (stores[Event.STORE] as Record<string, { by: number }[]>)[
          "in/Hit"
        ]![0]!.by = 100;
        expect(world.hash()).toBe(hash);
        yield* app.tick(1 / 60);
        yield* app.tick(1 / 60);
        expect((yield* app.inspect()).stores).toEqual({});
      })
  );

  it.effect(
    "hands out copies, which change nothing of the game when written",
    () =>
      Effect.gen(function* () {
        const Seed = Plugin.make("in/Seed", {
          setup: Effect.gen(function* () {
            (yield* Commands.spawns(Position)).spawn(
              Position.of({ x: 1, y: 2 })
            );
          }),
        });
        const app = yield* App.make(
          App.define({ plugins: [Seed], systems: [Scorer], handlers })
        );
        yield* app.enqueue(Strike, { by: 3 });
        yield* app.tick(1 / 60);
        const world = yield* worldOf(app);
        expect(world.singleton(Score).points).toBe(3);
        const hash = world.hash();
        const inspection = yield* app.inspect();
        expect(world.hash()).toBe(hash);
        const position = inspection.entities[0]!.components["in/Position"] as {
          x: number;
        };
        position.x = 100;
        (inspection.singletons["in/Score"] as { points: number }).points = 100;
        expect(world.hash()).toBe(hash);
        expect(
          (yield* app.inspect()).entities[0]!.components["in/Position"]
        ).toEqual({
          x: 1,
          y: 2,
        });
      })
  );

  it.effect(
    "lists every system in the order it runs, with whether its last turn ran it and how long it took",
    () =>
      Effect.gen(function* () {
        const app = yield* game;
        const before = (yield* app.inspect()).systems;
        expect(before.map(({ name, stage }) => [name, stage])).toEqual([
          ["in/Move", "update"],
          ["in/Scorer", "update"],
          ["in/Asleep", "update"],
          ["in/Opening", "update"],
          ["in/Read", "input"],
          ["in/Draw", "frame"],
        ]);
        // No system has had a turn yet.
        expect(before.every(({ ms, ran }) => !ran && ms === 0)).toBe(true);

        yield* app.input();
        yield* app.tick(1 / 60);
        yield* app.frame(0.5);
        const after = Object.fromEntries(
          (yield* app.inspect()).systems.map((system) => [system.name, system])
        );
        expect(after["in/Move"]!.ran).toBe(true);
        expect(after["in/Scorer"]!.ran).toBe(true);
        expect(after["in/Asleep"]!.ran).toBe(false);
        expect(after["in/Opening"]!.ran).toBe(false);
        expect(after["in/Read"]!.ran).toBe(true);
        expect(after["in/Draw"]!.ran).toBe(true);
        for (const { ms } of Object.values(after)) {
          expect(ms).toBeGreaterThanOrEqual(0);
          expect(Number.isFinite(ms)).toBe(true);
        }

        yield* app.enqueue(Begin, {});
        yield* app.tick(1 / 60);
        const opening = (yield* app.inspect()).systems.find(
          (system) => system.name === "in/Opening"
        )!;
        expect(opening.ran).toBe(true);
      })
  );

  it.effect("says the same of an app that traces", () =>
    Effect.gen(function* () {
      // A tracer that makes spans and keeps none, as one that sends them does.
      const tracer = Tracer.make({
        span: (options) => new Tracer.NativeSpan(options),
      });
      let traced = false;
      const Look = System.tick("in/Look", function* () {
        traced = Option.isSome(yield* Effect.option(Effect.currentSpan));
      });
      const app = yield* App.make(
        App.define({ systems: [Move, Asleep, Look] })
      ).pipe(Effect.provideService(Tracer.Tracer, tracer));
      yield* app.tick(1 / 60);
      expect(traced).toBe(true);
      expect(
        (yield* app.inspect()).systems.map(({ name, ran }) => [name, ran])
      ).toEqual([
        ["in/Move", true],
        ["in/Asleep", false],
        ["in/Look", true],
      ]);
    })
  );

  it.effect("times each system's turn", () =>
    Effect.gen(function* () {
      const Slow = System.tick("in/Slow", function* () {
        const until = performance.now() + 5;
        while (performance.now() < until) {
          // Busy, for the clock to see.
        }
      });
      const app = yield* App.make(App.define({ systems: [Slow] }));
      yield* app.tick(1 / 60);
      const [slow] = (yield* app.inspect()).systems;
      expect(slow!.ms).toBeGreaterThanOrEqual(5);
      expect(slow!.ms).toBeLessThan(1000);
    })
  );

  it.effect(
    "holds the events of the last tick by name, from actions, hooks and systems alike, and not those of the tick before",
    () =>
      Effect.gen(function* () {
        const app = yield* game;
        yield* app.enqueue(Strike, { by: 2 });
        yield* app.enqueue(Begin, {});
        yield* app.enqueue(Strike, { by: 3 });
        yield* app.tick(1 / 60);
        expect((yield* app.inspect()).events).toEqual({
          "in/Hit": [{ by: 2 }, { by: 3 }],
          "in/Spawned": [{}],
        });
        yield* app.tick(1 / 60);
        expect((yield* app.inspect()).events).toEqual({});
      })
  );

  it.effect("holds a refusal, and not what the refused handler emitted", () =>
    Effect.gen(function* () {
      const app = yield* game;
      yield* app.enqueue(Refuse, {});
      yield* app.tick(1 / 60);
      const { events } = yield* app.inspect();
      expect(Object.keys(events)).toEqual([
        Action.Rejected.name,
        Action.rejected(Refuse).name,
      ]);
      expect(events[Action.Rejected.name]).toEqual([
        {
          action: "in/Refuse",
          payload: {},
          error: { _tag: "in/NotNow" },
          from: undefined,
        },
      ]);
      expect(events[Action.rejected(Refuse).name]).toEqual([
        { payload: {}, error: NotNow.make({}), from: undefined },
      ]);
    })
  );

  it.effect(
    "counts an event emitted between two ticks as the next tick's",
    () =>
      Effect.gen(function* () {
        const app = yield* game;
        yield* app.tick(1 / 60);
        yield* app.dispatch(Strike, { by: 4 });
        expect((yield* app.inspect()).events).toEqual({});
        yield* app.tick(1 / 60);
        expect((yield* app.inspect()).events).toEqual({
          "in/Hit": [{ by: 4 }],
        });
      })
  );

  it.effect("forgets the last tick's events when the game is rewound", () =>
    Effect.gen(function* () {
      const app = yield* game;
      const moment = yield* Effect.exit(Timeline.capture(app));
      if (moment._tag !== "Success") {
        throw new Error("not captured");
      }
      yield* app.enqueue(Strike, { by: 1 });
      yield* app.tick(1 / 60);
      yield* Timeline.rewind(app, moment.value);
      expect((yield* app.inspect()).events).toEqual({});
    })
  );

  it.effect("is refused during a tick", () =>
    Effect.gen(function* () {
      let app: App.App | undefined;
      const Peek = System.tick("in/Peek", function* () {
        yield* World;
        yield* app!.inspect();
      });
      app = yield* App.make(App.define({ systems: [Peek] }));
      expect(yield* thrown(app.tick(1 / 60))).toThrow(/between ticks/);
    })
  );

  it.effect("works on an app that spawns through commands", () =>
    Effect.gen(function* () {
      const Spawner = System.tick("in/Spawner", function* () {
        (yield* Commands.spawns(Position)).spawn(Position.of({ x: 5, y: 5 }));
      });
      const app = yield* App.make(App.define({ systems: [Spawner] }));
      yield* app.tick(1 / 60);
      expect((yield* app.inspect()).entities.map((e) => e.components)).toEqual([
        { "in/Position": { x: 5, y: 5 } },
      ]);
    })
  );
});
