import { Data, Effect, Option, Schema, Tracer } from "effect";
import { describe, expect, it } from "vitest";

import type { Spawned } from "../src/index";
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
} from "../src/index";
import { placedIn } from "./placed";

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
const Name = Component.define("in/Name", { text: Field.json<string>() });
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
const Refuse = Action.define("in/Refuse", Schema.Struct({}));

class NotNow extends Data.TaggedError("in/NotNow") {}

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
    return yield* new NotNow();
  }),
];

const game = App.make(
  App.define({ systems: [Draw, Read, Move, Scorer, Asleep, Opening], handlers })
);

const worldOf = (app: Pick<App.Any, "read">) => Effect.runSync(app.read(World));

describe("app.inspect", () => {
  it("copies every live entity, in order, with its components by name, sparse ones and tags included", () => {
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
    const app = Effect.runSync(App.make(App.define({ plugins: [Seed] })));
    const world = worldOf(app);
    const [parent, child, bare] = ids.map((id) => placedIn(world, id));

    const { entities } = app.inspect();
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
  });

  it("copies every singleton the world holds, by name", () => {
    const app = Effect.runSync(game);
    app.enqueue(Strike, { by: 7 });
    app.tick(1 / 60);
    expect(app.inspect().singletons["in/Score"]).toEqual({ points: 7 });
  });

  it("shows the actions queued for the next tick and the events waiting to be read, as plain data", () => {
    const app = Effect.runSync(game);
    expect(app.inspect().stores).toEqual({});
    app.dispatch(Strike, { by: 5 });
    app.enqueue(Strike, { by: 6 });
    const world = worldOf(app);
    const hash = world.hash();
    const { stores } = app.inspect();
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
    app.tick(1 / 60);
    app.tick(1 / 60);
    expect(app.inspect().stores).toEqual({});
  });

  it("hands out copies, which change nothing of the game when written", () => {
    const Seed = Plugin.make("in/Seed", {
      setup: Effect.gen(function* () {
        (yield* Commands.spawns(Position)).spawn(Position.of({ x: 1, y: 2 }));
      }),
    });
    const app = Effect.runSync(
      App.make(App.define({ plugins: [Seed], systems: [Scorer], handlers }))
    );
    app.enqueue(Strike, { by: 3 });
    app.tick(1 / 60);
    const world = worldOf(app);
    expect(world.singleton(Score).points).toBe(3);
    const hash = world.hash();
    const inspection = app.inspect();
    expect(world.hash()).toBe(hash);
    const position = inspection.entities[0]!.components["in/Position"] as {
      x: number;
    };
    position.x = 100;
    (inspection.singletons["in/Score"] as { points: number }).points = 100;
    expect(world.hash()).toBe(hash);
    expect(app.inspect().entities[0]!.components["in/Position"]).toEqual({
      x: 1,
      y: 2,
    });
  });

  it("lists every system in the order it runs, with whether its last turn ran it and how long it took", () => {
    const app = Effect.runSync(game);
    const before = app.inspect().systems;
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

    app.input();
    app.tick(1 / 60);
    app.frame(0.5);
    const after = Object.fromEntries(
      app.inspect().systems.map((system) => [system.name, system])
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

    app.enqueue(Begin, {});
    app.tick(1 / 60);
    const opening = app
      .inspect()
      .systems.find((system) => system.name === "in/Opening")!;
    expect(opening.ran).toBe(true);
  });

  it("says the same of an app that traces", () => {
    // A tracer that makes spans and keeps none, as one that sends them does.
    const tracer = Tracer.make({
      span: (options) => new Tracer.NativeSpan(options),
    });
    let traced = false;
    const Look = System.tick("in/Look", function* () {
      traced = Option.isSome(yield* Effect.option(Effect.currentSpan));
    });
    const app = Effect.runSync(
      App.make(App.define({ systems: [Move, Asleep, Look] })).pipe(
        Effect.provideService(Tracer.Tracer, tracer)
      )
    );
    app.tick(1 / 60);
    expect(traced).toBe(true);
    expect(app.inspect().systems.map(({ name, ran }) => [name, ran])).toEqual([
      ["in/Move", true],
      ["in/Asleep", false],
      ["in/Look", true],
    ]);
  });

  it("times each system's turn", () => {
    const Slow = System.tick("in/Slow", function* () {
      const until = performance.now() + 5;
      while (performance.now() < until) {
        // Busy, for the clock to see.
      }
    });
    const app = Effect.runSync(App.make(App.define({ systems: [Slow] })));
    app.tick(1 / 60);
    const [slow] = app.inspect().systems;
    expect(slow!.ms).toBeGreaterThanOrEqual(5);
    expect(slow!.ms).toBeLessThan(1000);
  });

  it("holds the events of the last tick by name, from actions, hooks and systems alike, and not those of the tick before", () => {
    const app = Effect.runSync(game);
    app.enqueue(Strike, { by: 2 });
    app.enqueue(Begin, {});
    app.enqueue(Strike, { by: 3 });
    app.tick(1 / 60);
    expect(app.inspect().events).toEqual({
      "in/Hit": [{ by: 2 }, { by: 3 }],
      "in/Spawned": [{}],
    });
    app.tick(1 / 60);
    expect(app.inspect().events).toEqual({});
  });

  it("holds a refusal, and not what the refused handler emitted", () => {
    const app = Effect.runSync(game);
    app.enqueue(Refuse, {});
    app.tick(1 / 60);
    const { events } = app.inspect();
    expect(Object.keys(events)).toEqual([Action.Rejected.name]);
    expect(events[Action.Rejected.name]).toEqual([
      {
        action: "in/Refuse",
        payload: {},
        error: { _tag: "in/NotNow", message: "" },
        from: undefined,
      },
    ]);
  });

  it("counts an event emitted between two ticks as the next tick's", () => {
    const app = Effect.runSync(game);
    app.tick(1 / 60);
    app.dispatch(Strike, { by: 4 });
    expect(app.inspect().events).toEqual({});
    app.tick(1 / 60);
    expect(app.inspect().events).toEqual({ "in/Hit": [{ by: 4 }] });
  });

  it("forgets the last tick's events when the game is rewound", () => {
    const app = Effect.runSync(game);
    const moment = Timeline.capture(app);
    if (moment._tag !== "Success") {
      throw new Error("not captured");
    }
    app.enqueue(Strike, { by: 1 });
    app.tick(1 / 60);
    Timeline.rewind(app, moment.value);
    expect(app.inspect().events).toEqual({});
  });

  it("is refused during a tick", () => {
    let app: App.Any | undefined;
    const Peek = System.tick("in/Peek", function* () {
      yield* World;
      app!.inspect();
    });
    app = Effect.runSync(App.make(App.define({ systems: [Peek] })));
    expect(() => app.tick(1 / 60)).toThrow(/between ticks/);
  });

  it("works on an app that spawns through commands", () => {
    const Spawner = System.tick("in/Spawner", function* () {
      (yield* Commands.spawns(Position)).spawn(Position.of({ x: 5, y: 5 }));
    });
    const app = Effect.runSync(App.make(App.define({ systems: [Spawner] })));
    app.tick(1 / 60);
    expect(app.inspect().entities.map((e) => e.components)).toEqual([
      { "in/Position": { x: 5, y: 5 } },
    ]);
  });
});
