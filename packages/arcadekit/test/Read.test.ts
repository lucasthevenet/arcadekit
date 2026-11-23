import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  Action,
  App,
  Commands,
  Component,
  EcsWorld,
  Event,
  Field,
  Journal,
  Plugin,
  Query,
  Singleton,
  State,
  System,
  Time,
  World,
} from "../src/index";
import * as Services from "../src/Services";

const Position = Component.define("rd/Position", { x: Field.f32 });
const Score = Singleton.define(
  "rd/Score",
  { points: Field.u32 },
  { points: 0 }
);
const Phase = State.define("rd/Phase", ["menu", "playing"]);
const Ping = Event.define("rd/Ping", Schema.Struct({ n: Schema.Int }));
const Placed = Query.all(Position);
const Pushed = Query.all(Position).pipe(Query.writes(Position));
const Moved = Query.all(Position).pipe(Query.changed(Position));

const Drop = Action.define("rd/Drop", Schema.Struct({ x: Schema.Number }));
const drop = Action.handler(Drop, function* ({ x }) {
  (yield* Commands.spawns(Position)).spawn(Position.of({ x }));
});

const Rules = Plugin.make("rd/Rules", {
  handlers: [drop],
  setup: Effect.gen(function* () {
    (yield* Commands.spawns(Position)).spawn(Position.of({ x: 4 }));
  }),
});
const Game = App.define({ plugins: [Rules] });

describe("a game, from outside it", () => {
  it("is read with app.read: the world, a query that reads, a singleton, a state and the time", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const app = yield* App.make(Game);
        app.tick(1 / 60);
        const world = yield* app.read(World);
        const [rock] = (yield* app.read(Placed)).entities();
        expect(world.get(rock!, Position)).toEqual({ x: 4 });
        expect(world.entityCount).toBe(1);
        expect(yield* app.read(Score)).toEqual({ points: 0 });
        expect((yield* app.read(Phase)).value).toBe("menu");
        expect((yield* app.read(Time)).tick).toBe(1);
        expect(
          yield* app.read(
            Effect.gen(function* () {
              return (yield* World).hash();
            })
          )
        ).toBe(world.hash());
      })
    );
  });

  it("is changed by an action alone: the app has no world to write, and app.read takes nothing that writes", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const app = yield* App.make(Game);
        // @ts-expect-error the app hands out no world
        void app.world;
        // @ts-expect-error nor the buffer of commands
        void app.commands;
        const world = yield* app.read(World);
        // @ts-expect-error the world app.read gives has no spawn
        void world.spawn;
        // Nor is it the world itself, which a check of its class would write through.
        expect(world).not.toBeInstanceOf(EcsWorld);
        const scoreFive = () => {
          // @ts-expect-error a singleton it reads is read-only
          world.singleton(Score).points = 5;
        };
        void scoreFive;
        const reads = [
          // @ts-expect-error commands change the game
          app.read(Commands.spawns(Position)),
          // @ts-expect-error World.writes changes it
          app.read(World.writes(Position)),
          // @ts-expect-error a query that writes changes it
          app.read(Pushed),
          // @ts-expect-error what a change query has visited is the game's
          app.read(Moved),
          // @ts-expect-error and so is what a removal query has read
          app.read(Query.removed(Position)),
          // @ts-expect-error an event is heard by the game's own code
          app.read(Ping),
          // @ts-expect-error setting a state changes it
          app.read(Phase.sets),
          // @ts-expect-error writing a singleton changes it
          app.read(Score.writes),
        ];
        expect(reads).toHaveLength(8);
        expect(app.enqueue(Drop, { x: 1 })).toEqual(
          expect.objectContaining({ _tag: "Success" })
        );
        app.tick(1 / 60);
        expect(world.entityCount).toBe(2);
      })
    );
  });

  it("is replayed to the same world, since what changed it is in the log", () => {
    const { count, recording } = Effect.runSync(
      Effect.gen(function* () {
        const app = yield* App.make(Game, { checkpointEvery: 0 });
        for (let n = 0; n < 5; n++) {
          app.tick(1 / 60);
        }
        app.enqueue(Drop, { x: 2 });
        for (let n = 0; n < 5; n++) {
          app.tick(1 / 60);
        }
        return {
          count: (yield* app.read(World)).entityCount,
          recording: app.record(),
        };
      })
    );
    expect(count).toBe(2);
    const replayed = Effect.runSync(
      Effect.gen(function* () {
        const app = yield* Journal.replay(recording, Game, {
          checkpointEvery: 0,
        });
        return (yield* app.read(World)).entityCount;
      })
    );
    expect(replayed).toBe(count);
  });

  it("is read between ticks, and not from inside one", () => {
    const outside: { app?: App.Any } = {};
    const Peek = System.tick("rd/Peek", function* () {
      if (outside.app !== undefined) {
        yield* outside.app.read(World);
      }
    });
    expect(() =>
      Effect.runSync(
        Effect.gen(function* () {
          const app = yield* App.make(App.define({ systems: [Peek] }));
          outside.app = app;
          app.tick(1 / 60);
        })
      )
    ).toThrow(/app\.read\(\) was run during a tick/);
  });
});

describe("the world a system is handed", () => {
  it("is not the world itself, so no check of its class reaches spawn or despawn", () => {
    const seen: unknown[] = [];
    const Look = System.tick("rd/Look", function* () {
      seen.push(yield* World, yield* World.writes(Position));
    });
    Effect.runSync(
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ systems: [Look] }));
        app.tick(1 / 60);
        expect(seen).toHaveLength(2);
        for (const world of seen) {
          expect(world).not.toBeInstanceOf(EcsWorld);
        }
        // One world, whoever asks in the tick, with or without writes.
        expect(new Set(seen).size).toBe(1);
        // app.read hands a world of its own, which only reads.
        const read = yield* app.read(World);
        expect(read).not.toBeInstanceOf(EcsWorld);
        expect(seen).not.toContain(read);
      })
    );
    // What unwraps it is no export of the entry.
    expect(Object.keys(Services)).not.toContain("whole");
  });
});
