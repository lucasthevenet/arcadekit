import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { World as EcsWorld } from "../src/ecs/index.ts";
import {
  Action,
  App,
  Commands,
  Component,
  Event,
  Field,
  Plugin,
  Query,
  Replay,
  Singleton,
  State,
  System,
  Test,
  Time,
  World,
} from "../src/index.ts";
import type { Entity, Spawning, WritingWorld } from "../src/index.ts";
import * as Services from "../src/Services.ts";
import { thrown } from "./checks.ts";

const Position = Component.define("rd/Position", { x: Field.f32 });
const Aim = Component.define("rd/Aim", { at: Field.entity });
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

const Drop = Action.define("rd/Drop", {
  payload: Schema.Struct({ x: Schema.Number }),
});
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
  it.effect(
    "is read with app.read: the world, a query that reads, a singleton, a state and the time",
    () =>
      Effect.gen(function* () {
        const app = yield* App.make(Game);
        yield* app.tick(1 / 60);
        const world = yield* app.read(World);
        const [rock] = (yield* app.read(Query.View(Placed))).entities();
        expect(world.get(rock!, Position)).toEqual({ x: 4 });
        expect(world.entityCount).toBe(1);
        expect(yield* app.read(Singleton.Read(Score))).toEqual({ points: 0 });
        expect((yield* app.read(State.Reader(Phase))).value).toBe("menu");
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

  it.effect(
    "is changed by an action alone: the app has no world to write, and app.read takes nothing that writes",
    () =>
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
          app.read(Query.View(Pushed)),
          // @ts-expect-error what a change query has visited is the game's
          app.read(Query.View(Moved)),
          // @ts-expect-error and so is what a removal query has read
          app.read(Query.Removed(Position)),
          // @ts-expect-error an event is heard by the game's own code
          app.read(Event.Reader(Ping)),
          // @ts-expect-error setting a state changes it
          app.read(State.Setter(Phase)),
          // @ts-expect-error writing a singleton changes it
          app.read(Singleton.Write(Score)),
        ];
        expect(reads).toHaveLength(8);
        expect(yield* Effect.exit(app.enqueue(Drop, { x: 1 }))).toEqual(
          expect.objectContaining({ _tag: "Success" })
        );
        yield* app.tick(1 / 60);
        expect(world.entityCount).toBe(2);
      })
  );

  it.effect(
    "is replayed to the same world, since what changed it is in the log",
    () =>
      Effect.gen(function* () {
        const app = yield* App.make(Game, { hashEvery: 0 });
        for (let n = 0; n < 5; n++) {
          yield* app.tick(1 / 60);
        }
        yield* app.enqueue(Drop, { x: 2 });
        for (let n = 0; n < 5; n++) {
          yield* app.tick(1 / 60);
        }
        const count = (yield* app.read(World)).entityCount;
        const recording = yield* Replay.record(app);
        expect(count).toBe(2);
        const replayed = yield* Replay.verify(recording, Game, {
          hashEvery: 0,
        });
        expect((yield* replayed.read(World)).entityCount).toBe(count);
      })
  );

  it.effect("is read between ticks, and not from inside one", () =>
    Effect.gen(function* () {
      const outside: { app?: App.Any } = {};
      const Peek = System.tick("rd/Peek", function* () {
        if (outside.app !== undefined) {
          yield* outside.app.read(World);
        }
      });
      expect(
        yield* thrown(
          Effect.gen(function* () {
            const app = yield* App.make(App.define({ systems: [Peek] }));
            outside.app = app;
            yield* app.tick(1 / 60);
          })
        )
      ).toThrow(/app\.read\(\) was run during a tick/);
    })
  );
});

describe("the world a system is handed", () => {
  it.effect(
    "turns a Field.entity back into its entity with live, as the world app.read hands out does",
    () =>
      Effect.gen(function* () {
        const seen: unknown[] = [];
        const Aimed = Query.all(Aim);
        const Look = System.tick("rd/Look", function* () {
          const world = yield* World;
          (yield* Query.View(Aimed)).each((aim) => {
            seen.push(world.live(aim.at));
          });
        });
        const Setup = Plugin.make("rd/Aims", {
          systems: [Look],
          setup: Effect.gen(function* () {
            const commands = yield* Commands.spawns(Position, Aim);
            const rock = commands.spawn(Position.of({ x: 1 }));
            commands.spawn(Aim.of({ at: rock }));
          }),
        });
        {
          const app = yield* App.make(App.define({ plugins: [Setup] }));
          yield* app.tick(1 / 60);
          const world = yield* app.read(World);
          const [rock] = (yield* app.read(Query.View(Placed))).entities();
          const [aim] = (yield* app.read(Query.View(Aimed))).entities();
          const ref = world.get(aim!, Aim)!.at;
          expect(seen).toEqual([rock]);
          expect(world.live(ref)).toBe(rock);
        }
      })
  );

  it.effect(
    "is not the world itself, so no check of its class reaches spawn or despawn",
    () =>
      Effect.gen(function* () {
        const seen: unknown[] = [];
        const Look = System.tick("rd/Look", function* () {
          seen.push(yield* World, yield* World.writes(Position));
        });
        const app = yield* App.make(App.define({ systems: [Look] }));
        yield* app.tick(1 / 60);
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
        // What unwraps it is no export of the entry.
        expect(Object.keys(Services)).not.toContain("whole");
      })
  );
});

describe("the player of a game", () => {
  const Player = Component.tag("rd/Player");
  const Players = Query.all(Position).pipe(Query.with(Player));
  const Run = Plugin.make("rd/Run", {
    setup: Effect.gen(function* () {
      const commands = yield* Commands.spawns(Position, Player);
      commands.spawn(Position.of({ x: 1 }));
      commands.spawn(Position.of({ x: 2 }), Player);
    }),
  });

  it.effect("is read in one call, in a system and through app.read", () =>
    Effect.gen(function* () {
      const seen: number[] = [];
      const Walk = System.tick("rd/Walk", function* () {
        const [position] = (yield* Query.View(
          Players.pipe(Query.writes(Position))
        )).single();
        position.x += 1;
        seen.push(position.x);
      });
      const game = yield* Test.make(
        App.define({ plugins: [Run], systems: [Walk] })
      );
      yield* game.step();
      yield* game.step();
      const [position, player] = (yield* game.app.read(
        Query.View(Players)
      )).single();
      expect([seen, position.x]).toEqual([[3, 4], 4]);
      expect((yield* game.app.read(World)).has(player, Player)).toBe(true);
    })
  );
});

describe("a plain function that takes what a system was handed", () => {
  const Health = Component.define("rd/Health", { hp: Field.i32 });
  const Spark = Component.tag("rd/Spark");
  /** Strikes a target, for a handler and a system alike. */
  const strike = (
    world: WritingWorld<"rd/Health">,
    commands: Spawning<"rd/Spark">,
    score: Singleton.Write<typeof Score>,
    target: Entity
  ): void => {
    world.set(target, Health, { hp: world.get(target, Health)!.hp - 1 });
    commands.spawn(Spark);
    score.points += 1;
  };

  it.effect(
    "takes the world and commands of a system that writes and spawns more",
    () =>
      Effect.gen(function* () {
        const Strike = System.tick("rd/Strike", function* () {
          const world = yield* World.writes(Position, Health);
          const commands = yield* Commands.spawns(Position, Spark);
          for (const target of (yield* Query.View(
            Query.all(Health)
          )).entities()) {
            strike(world, commands, yield* Singleton.Write(Score), target);
            world.set(target, Position, { x: 9 });
          }
        });
        const Spawn = Plugin.make("rd/Targets", {
          setup: Effect.gen(function* () {
            (yield* Commands.spawns(Health, Position)).spawn(
              Health.of({ hp: 3 }),
              Position
            );
          }),
        });
        const game = yield* Test.make(
          App.define({ plugins: [Spawn], systems: [Strike] })
        );
        yield* game.step();
        const world = yield* game.app.read(World);
        const [target] = (yield* game.app.read(
          Query.View(Query.all(Health))
        )).entities();
        expect(world.get(target!, Health)).toEqual({ hp: 2 });
        expect(
          (yield* game.app.read(
            Query.View(Query.all().pipe(Query.with(Spark)))
          )).count()
        ).toBe(1);
        expect((yield* game.app.read(Singleton.Read(Score))).points).toBe(1);
      })
  );

  it("doesn't take a world or commands that write or spawn less than it does", () => {
    System.tick("rd/Less", function* () {
      const target = (yield* Query.View(Query.all(Health))).entities()[0]!;
      strike(
        // @ts-expect-error the world was not asked for health
        yield* World.writes(Position),
        yield* Commands.spawns(Spark),
        yield* Singleton.Write(Score),
        target
      );
      strike(
        // @ts-expect-error a world that only reads sets nothing
        yield* World,
        yield* Commands.spawns(Spark),
        yield* Singleton.Write(Score),
        target
      );
      strike(
        yield* World.writes(Health),
        // @ts-expect-error the commands were not asked for sparks
        yield* Commands.spawns(Position),
        yield* Singleton.Write(Score),
        target
      );
      strike(
        yield* World.writes(Health),
        yield* Commands.spawns(Spark),
        // @ts-expect-error a singleton read is not a singleton written
        yield* Singleton.Read(Score),
        target
      );
    });
    // Nor does a world that writes less pass for one that writes more.
    const both = (_world: WritingWorld<"rd/Health" | "rd/Position">) => {};
    System.tick("rd/More", function* () {
      both(
        // @ts-expect-error the world was not asked for positions
        yield* World.writes(Health)
      );
    });
    expectTypeOf<WritingWorld<"rd/Health" | "rd/Position">>().toExtend<
      WritingWorld<"rd/Health">
    >();
    expectTypeOf<WritingWorld<"rd/Health">>().not.toExtend<
      WritingWorld<"rd/Health" | "rd/Position">
    >();
    expectTypeOf<Spawning<"rd/Spark" | "rd/Position">>().toExtend<
      Spawning<"rd/Spark">
    >();
    expectTypeOf<Spawning<"rd/Spark">>().not.toExtend<
      Spawning<"rd/Spark" | "rd/Position">
    >();
  });
});
