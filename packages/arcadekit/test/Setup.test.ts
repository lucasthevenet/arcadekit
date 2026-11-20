import { Effect, Exit } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  App,
  Commands,
  Component,
  Event,
  Field,
  Query,
  Singleton,
  System,
  Time,
  World,
} from "../src/index";

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): A =>
  Effect.runSync(Effect.scoped(effect));

const Position = Component.define("su/Position", { x: Field.f32 });
const Velocity = Component.define("su/Velocity", { x: Field.f32 });
const Health = Component.define("su/Health", { hp: Field.i32 });
const Score = Singleton.define(
  "su/Score",
  { points: Field.i32 },
  { points: 0 }
);
const Scored = Event.define<number>("su/Scored");

const Moving = Query.all(Position, Velocity).pipe(Query.reads(Velocity));
const Positions = Query.all(Position).pipe(Query.reads(Position));
const Wounded = Query.all(Health);

const Movement = System.setup("su/Movement", function* () {
  const moving = yield* Moving;
  return Effect.gen(function* () {
    const { delta } = yield* Time;
    moving.each((pos, vel) => {
      pos.x += vel.x * delta;
    });
  });
});

// The same system, written as one generator.
const MovementInOne = System.make("su/Movement", function* () {
  const moving = yield* Moving;
  const { delta } = yield* Time;
  moving.each((pos, vel) => {
    pos.x += vel.x * delta;
  });
});

const Scoring = System.setup("su/Scoring", function* () {
  const positions = yield* Positions;
  const score = yield* Score;
  const scored = yield* Scored;
  return Effect.gen(function* () {
    positions.each((pos) => {
      if (pos.x > 3) {
        score.points += 1;
        scored.emit(score.points);
      }
    });
  });
});

const spawnRow = (app: App.Any): void => {
  for (let i = 0; i < 20; i++) {
    app.world.spawn(Position.of({ x: i / 10 }), Velocity.of({ x: 1 + i }));
  }
};

describe("System.setup", () => {
  it("knows what a system touches when the app is made, before its first tick", () => {
    const Reader = System.make("su/Reader", function* () {
      (yield* Positions).count();
    }).pipe(System.access({ queries: [Positions] }));
    const app = run(App.make({ systems: [Movement, Scoring, Reader] }));
    // Nothing was declared, and nothing is undeclared.
    expect(app.undeclared).toEqual([]);
    // Movement writes Position; both of the others read it, and nothing orders them.
    expect(
      app.conflicts.map(({ first, second, over }) => [
        first,
        second,
        over.map(({ what }) => what).join(),
      ])
    ).toEqual([
      ["su/Movement", "su/Scoring", "su/Position"],
      ["su/Movement", "su/Reader", "su/Position"],
    ]);
  });

  it("plays the same game as the system written in one generator, tick for tick", () => {
    const set = run(App.make({ systems: [Movement] }));
    const inOne = run(App.make({ systems: [MovementInOne] }));
    spawnRow(set);
    spawnRow(inOne);
    for (let tick = 0; tick < 30; tick++) {
      set.tick(1 / 60);
      inOne.tick(1 / 60);
      expect(set.world.hash()).toBe(inOne.world.hash());
    }
  });

  it("keeps what it acquired good after a rewind puts the world back", () => {
    const app = run(
      App.make({ components: [Score], systems: [Movement, Scoring] })
    );
    spawnRow(app);
    app.tick(1 / 60);
    const moment = app.capture();
    if (Exit.isFailure(moment)) {
      throw new Error("The game could not be captured");
    }
    const hashes: number[] = [];
    for (let tick = 0; tick < 20; tick++) {
      app.tick(1 / 10);
      hashes.push(app.world.hash());
    }
    const scored = app.world.singleton(Score).points;
    expect(scored).toBeGreaterThan(0);
    app.rewind(moment.value);
    const again: number[] = [];
    for (let tick = 0; tick < 20; tick++) {
      app.tick(1 / 10);
      again.push(app.world.hash());
    }
    expect(again).toEqual(hashes);
    expect(app.world.singleton(Score).points).toBe(scored);
  });

  it("holds the tick to what the setup acquired", () => {
    const Sneaky = System.setup(
      "su/Sneaky",
      // @ts-expect-error: a tick can't reach the game itself.
      function* () {
        yield* Positions;
        return Effect.gen(function* () {
          const world = yield* World;
          world.view(Wounded).count();
        });
      }
    );
    const app = run(App.make({ systems: [Sneaky] }));
    expect(() => app.tick(1 / 60)).toThrow(
      /System "su\/Sneaky" .*"su\/Health"/s
    );
  });

  it("refuses a setup that reads or changes the game, which it does in its tick", () => {
    const Counting = System.setup("su/Counting", function* () {
      const positions = yield* Positions;
      positions.count();
      return Effect.void;
    });
    expect(() => run(App.make({ systems: [Counting] }))).toThrow(
      'A query of System "su/Counting" was used in a system\'s setup. The setup runs once, before the first tick, and only acquires what the system touches: use it in the tick it returns.'
    );
    const Spawning = System.setup("su/Spawning", function* () {
      const world = yield* World;
      world.spawn(Position.of({ x: 1 }));
      return Effect.void;
    });
    expect(() => run(App.make({ systems: [Spawning] }))).toThrow(
      'System "su/Spawning" called world.spawn in its setup. The setup runs once, before the first tick, and only acquires what the system touches, with yield*: a query, a singleton or an event.'
    );
  });

  it("acquires the commands in the setup, and the compiler refuses them in the tick, but not what they will write", () => {
    System.setup(
      "su/Typed",
      // @ts-expect-error: Commands is acquired in the setup, not the tick.
      function* () {
        yield* Positions;
        return Effect.gen(function* () {
          (yield* Commands).spawn(Position.of({ x: 1 }));
        });
      }
    );
    const spawner = (name: string) =>
      System.setup(name, function* () {
        const commands = yield* Commands;
        return Effect.sync(() => {
          commands.spawn(Position.of({ x: 1 }));
        });
      });
    // What its commands will write isn't known from acquiring them: a
    // spawn of a component it acquired nothing of is refused.
    const unsaid = run(App.make({ systems: [spawner("su/Unsaid")] }));
    expect(() => unsaid.tick(1 / 60)).toThrow(
      /System "su\/Unsaid" spawned an entity with "su\/Position"/
    );
    // Said beside the setup, it is let through.
    const said = run(
      App.make({
        systems: [
          spawner("su/Said").pipe(System.access({ writes: [Position] })),
        ],
      })
    );
    said.tick(1 / 60);
    said.tick(1 / 60);
    expect(said.world.view(Positions).count()).toBe(2);
  });
});
