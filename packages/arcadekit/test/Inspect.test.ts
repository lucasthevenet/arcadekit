import { Data, Effect, Option, Schema, Tracer } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  Action,
  App,
  Commands,
  Component,
  Event,
  Field,
  Query,
  Singleton,
  State,
  System,
  World,
} from "../src/index";

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): A =>
  Effect.runSync(Effect.scoped(effect));

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

const Moved = Query.all(Position);
const Move = System.make("in/Move", function* () {
  (yield* Moved).each((position) => {
    position.x += 1;
  });
});
const Scorer = System.make("in/Scorer", function* () {
  const hits = (yield* Hit).read();
  for (const { by } of hits) {
    (yield* Score).points += by;
  }
});
const Asleep = System.make("in/Asleep", function* () {}).pipe(
  System.runIf(Effect.succeed(false))
);
const Opening = System.make("in/Opening", function* () {
  (yield* Spawned).emit({});
}).pipe(State.onEnter(Phase, "playing"));
const Draw = System.make("in/Draw", function* () {}).pipe(
  System.inStage("frame")
);
const Read = System.make("in/Read", function* () {}).pipe(
  System.inStage("input")
);

const handlers = [
  Action.handler(Strike, function* ({ by }) {
    (yield* Hit).emit({ by });
  }),
  Action.handler(Begin, function* () {
    (yield* Phase).set("playing");
  }),
  Action.handler(Refuse, function* () {
    (yield* Hit).emit({ by: 1000 });
    return yield* new NotNow();
  }),
];

const game = App.make({
  components: [Position, Heat, Boss, Name, ChildOf, Score, Phase],
  events: [Hit, Spawned],
  systems: [Draw, Read, Move, Scorer, Asleep, Opening],
  handlers,
});

describe("app.inspect", () => {
  it("copies every live entity, in order, with its components by name, sparse ones and tags included", () => {
    const app = run(game);
    const { world } = app;
    const parent = world.spawn(
      Position.of({ x: 1, y: 2 }),
      Boss,
      Name.of({ text: "boss" })
    );
    const gone = world.spawn(Position.of({ x: 9, y: 9 }));
    const child = world.spawn(
      Position.of({ x: 3, y: 4 }),
      Heat.of({ degrees: 40 }),
      ChildOf.of({ target: parent })
    );
    const bare = world.spawn();
    world.despawn(gone);

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
    const app = run(game);
    app.world.singleton(Score).points = 7;
    app.tick(1 / 60, { input: false });
    expect(app.inspect().singletons["in/Score"]).toEqual({ points: 7 });
  });

  it("hands out copies, which change nothing of the game when written", () => {
    const app = run(game);
    app.world.spawn(Position.of({ x: 1, y: 2 }));
    app.world.singleton(Score).points = 3;
    const hash = app.world.hash();
    const inspection = app.inspect();
    expect(app.world.hash()).toBe(hash);
    const position = inspection.entities[0]!.components["in/Position"] as {
      x: number;
    };
    position.x = 100;
    (inspection.singletons["in/Score"] as { points: number }).points = 100;
    expect(app.world.hash()).toBe(hash);
    expect(app.inspect().entities[0]!.components["in/Position"]).toEqual({
      x: 1,
      y: 2,
    });
  });

  it("lists every system in the order it runs, with whether its last turn ran it and how long it took", () => {
    const app = run(game);
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
    const Look = System.make("in/Look", function* () {
      traced = Option.isSome(yield* Effect.option(Effect.currentSpan));
    });
    const app = run(
      App.make({
        components: [Position],
        systems: [Move, Asleep, Look],
      }).pipe(Effect.provideService(Tracer.Tracer, tracer))
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
    const Slow = System.make("in/Slow", function* () {
      const until = performance.now() + 5;
      while (performance.now() < until) {
        // Busy, for the clock to see.
      }
    });
    const app = run(App.make({ systems: [Slow] }));
    app.tick(1 / 60);
    const [slow] = app.inspect().systems;
    expect(slow!.ms).toBeGreaterThanOrEqual(5);
    expect(slow!.ms).toBeLessThan(1000);
  });

  it("holds the events of the last tick by name, from actions, hooks and systems alike, and not those of the tick before", () => {
    const app = run(game);
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
    const app = run(game);
    app.enqueue(Refuse, {});
    app.tick(1 / 60);
    const { events } = app.inspect();
    expect(Object.keys(events)).toEqual([Action.Rejected.name]);
    expect(events[Action.Rejected.name]).toEqual([
      {
        action: "in/Refuse",
        payload: {},
        error: new NotNow(),
        from: undefined,
      },
    ]);
  });

  it("counts an event emitted between two ticks as the next tick's", () => {
    const app = run(game);
    app.tick(1 / 60);
    app.dispatch(Strike, { by: 4 });
    expect(app.inspect().events).toEqual({});
    app.tick(1 / 60);
    expect(app.inspect().events).toEqual({ "in/Hit": [{ by: 4 }] });
  });

  it("forgets the last tick's events when the game is rewound", () => {
    const app = run(game);
    const moment = app.capture();
    if (moment._tag !== "Success") {
      throw new Error("not captured");
    }
    app.enqueue(Strike, { by: 1 });
    app.tick(1 / 60);
    app.rewind(moment.value);
    expect(app.inspect().events).toEqual({});
  });

  it("is refused during a tick", () => {
    let app: App.Any | undefined;
    const Peek = System.make("in/Peek", function* () {
      yield* World;
      app!.inspect();
    });
    app = run(App.make({ systems: [Peek] }));
    expect(() => app.tick(1 / 60)).toThrow(/between ticks/);
  });

  it("works on an app that spawns through commands", () => {
    const Spawner = System.make("in/Spawner", function* () {
      (yield* Commands).spawn(Position.of({ x: 5, y: 5 }));
    });
    const app = run(App.make({ components: [Position], systems: [Spawner] }));
    app.tick(1 / 60);
    expect(app.inspect().entities.map((e) => e.components)).toEqual([
      { "in/Position": { x: 5, y: 5 } },
    ]);
  });
});
