import { Effect, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  Action,
  App,
  Commands,
  Component,
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

const Position = Component.define("rd/Position", { x: Field.f32 });
const Score = Singleton.define("rd/Score", { points: Field.u32 }, { points: 0 });
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

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): A =>
  Effect.runSync(Effect.scoped(effect));

describe("a game, from outside it", () => {
  it("is read with app.read: the world, a query that reads, a singleton, a state and the time", () => {
    run(
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
    run(
      Effect.gen(function* () {
        const app = yield* App.make(Game);
        // @ts-expect-error the app hands out no world
        void app.world;
        // @ts-expect-error nor the buffer of commands
        void app.commands;
        const world = yield* app.read(World);
        // @ts-expect-error the world app.read gives has no spawn
        void world.spawn;
        const reads = [
          // @ts-expect-error commands change the game
          app.read(Commands.spawns(Position)),
          // @ts-expect-error World.writes changes it
          app.read(World.writes(Position)),
          // @ts-expect-error a query that writes changes it
          app.read(Pushed),
          // @ts-expect-error what a change query has visited is the game's
          app.read(Moved),
          // @ts-expect-error an event is heard by the game's own code
          app.read(Ping),
          // @ts-expect-error setting a state changes it
          app.read(Phase.sets),
          // @ts-expect-error writing a singleton changes it
          app.read(Score.writes),
        ];
        expect(reads).toHaveLength(7);
        expect(app.enqueue(Drop, { x: 1 })).toEqual(
          expect.objectContaining({ _tag: "Success" })
        );
        app.tick(1 / 60);
        expect(world.entityCount).toBe(2);
      })
    );
  });

  it("is replayed to the same world, since what changed it is in the log", () => {
    const { count, recording } = run(
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
    const replayed = run(
      Effect.gen(function* () {
        const app = yield* Journal.replay(recording, (start) =>
          App.make(Game, { ...start, checkpointEvery: 0 })
        );
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
      run(
        Effect.gen(function* () {
          const app = yield* App.make(App.define({ systems: [Peek] }));
          outside.app = app;
          app.tick(1 / 60);
        })
      )
    ).toThrow(/app\.read\(\) was run during a tick/);
  });
});
