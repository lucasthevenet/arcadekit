import { Effect, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  Action,
  App,
  Commands,
  Component,
  Field,
  Plugin,
  Query,
  State,
  System,
  Time,
  World,
} from "../src/index";
import type { Entity } from "../src/index";
import type { BuiltIn } from "../src/Services";

const Position = Component.define("or/Position", { x: Field.f32 });
const Health = Component.define("or/Health", { hp: Field.i32 });
const Phase = State.define("or/Phase", ["menu", "playing"]);

const Positions = Query.all(Position).pipe(Query.writes(Position));
const Moved = Query.all(Position).pipe(Query.changed(Position));
const Healths = Query.all(Health).pipe(Query.writes(Health));

/** Moves every position on the second tick, and on no other. */
const Move = System.tick("Move", function* () {
  if ((yield* Time).tick === 2) {
    (yield* Positions).each((position) => {
      position.x += 1;
    });
  }
});

/** A system that notes how many positions it found moved, each tick. */
const trail = (seen: number[]) =>
  System.tick("Trail", function* () {
    seen.push((yield* Moved).entities().length);
  });
const Trail = trail([]);

/** A system that writes health, and nothing a test here watches. */
const Bleed = System.tick("Bleed", function* () {
  (yield* Healths).each((health) => {
    health.hp -= 1;
  });
});

/** Builds an app, hands it to `use`, then closes its scope. */
const withApp = <T, A>(
  make: Effect.Effect<T, never, Scope.Scope>,
  use: (app: T) => A
): A => Effect.runSync(Effect.scoped(Effect.map(make, use)));

/** What the compiler says of a list, or that it says nothing. */
type Said<S extends readonly System.System<unknown, unknown>[]> = [
  System.Misordered<S>,
] extends [never]
  ? "nothing"
  : System.Misordered<S>;

const LATE =
  '"Trail" watches "or/Position" with Query.changed, and "Move" writes it later in the tick, so "Trail" would react a tick late. List "Trail" after "Move", or place it in a later stage.';

describe("the order of systems", () => {
  it("has a system that watches a component react in the tick it is written, and a list the other way round does not compile", () => {
    // Three ticks of one entity, moved on the second.
    const play = (app: App.Any): void => {
      app.world.spawn(Position.of({ x: 0 }));
      for (let n = 0; n < 3; n++) {
        app.tick(1);
      }
    };
    // Listed after what it watches: all of it on its first visit, then the
    // move in the tick it is made.
    const seen: number[] = [];
    withApp(App.make(App.define({ systems: [Move, trail(seen)] })), play);
    expect(seen).toEqual([1, 1, 0]);

    // Listed ahead of it, the move is seen a tick late. The compiler refuses
    // that list, and says which system goes where.
    App.define(
      // @ts-expect-error a watcher listed ahead of what it watches
      { systems: [Trail, Move] }
    );
    const said: Said<readonly [typeof Trail, typeof Move]> = LATE;
    const fine: Said<readonly [typeof Move, typeof Trail]> = "nothing";
    expect([said, fine]).toEqual([LATE, "nothing"]);

    // What it refuses is what happens: the same list, typed as any systems so
    // that the compiler cannot read it, runs the watcher a tick behind.
    const late: number[] = [];
    const unread: readonly System.System<never, BuiltIn>[] = [
      trail(late),
      Move,
    ];
    withApp(App.make(App.define({ systems: unread })), play);
    expect(late).toEqual([1, 0, 1]);
  });

  it("is read stage by stage, as a tick runs them, and not as the list has them", () => {
    // A later stage runs after an earlier one wherever it is listed.
    const TrailLast = Trail.pipe(System.inStage("postUpdate"));
    App.define({ systems: [TrailLast, Move] });
    const fine: Said<readonly [typeof TrailLast, typeof Move]> = "nothing";
    expect(fine).toBe("nothing");
    const TrailFirst = Trail.pipe(System.inStage("preUpdate"));
    App.define(
      // @ts-expect-error the stage of the watcher runs ahead of the writer's
      { systems: [Move, TrailFirst] }
    );
    const MoveLast = Move.pipe(System.inStage("postUpdate"));
    App.define(
      // @ts-expect-error the stage of the writer runs after the watcher's
      { systems: [MoveLast, Trail] }
    );
  });

  it("leaves out what runs at another moment: a hook, the frame and input stages, a handler", () => {
    const Reset = State.onEnter(Phase, "playing", "Reset", function* () {
      (yield* Positions).each((position) => {
        position.x = 0;
      });
    });
    const Drawn = System.frame("Drawn", function* () {
      (yield* Moved).each(() => {});
    });
    const Tap = Action.define("or/Tap", Schema.Struct({}));
    const tap = Action.handler(Tap, function* () {
      (yield* Positions).each((position) => {
        position.x -= 1;
      });
    });
    App.define({
      systems: [
        // Drawn between ticks, after every one of a tick's systems.
        Drawn,
        Move,
        Reset,
      ],
      // And a handler ahead of the tick's systems too.
      handlers: [tap],
    });
    const Hook = Reset;
    const none: Said<readonly [typeof Trail, typeof Hook]> = "nothing";
    expect(none).toBe("nothing");
    App.define({ systems: [Trail, Reset] });
  });

  it("knows what a system writes however the query is reached, with nothing declared", () => {
    // In a branch that a run may never take.
    const Sometimes = System.tick("Sometimes", function* () {
      if ((yield* Time).tick > 1000) {
        (yield* Positions).each((position) => {
          position.x = 0;
        });
      }
    });
    App.define(
      // @ts-expect-error the write is in a branch, and is the system's all the same
      { systems: [Trail, Sometimes] }
    );
    // Through another Effect, which carries what it needs as any Effect does.
    const nudge = Effect.gen(function* () {
      (yield* Positions).each((position) => {
        position.x += 1;
      });
    });
    const Helped = System.tick("Helped", function* () {
      yield* nudge;
    });
    App.define(
      // @ts-expect-error the write is in an Effect the system yields
      { systems: [Trail, Helped] }
    );
    // In a condition, which is the system's too.
    const Gated = Bleed.pipe(
      System.runIf(Effect.map(Moved, (moved) => moved.count() > 0))
    );
    App.define(
      // @ts-expect-error the condition watches what a later system writes
      { systems: [Gated, Move] }
    );
    // A system that writes something else is in nobody's way.
    App.define({ systems: [Trail, Bleed] });
    const said: Said<readonly [typeof Trail, typeof Helped]> =
      '"Trail" watches "or/Position" with Query.changed, and "Helped" writes it later in the tick, so "Trail" would react a tick late. List "Trail" after "Helped", or place it in a later stage.';
    expect(said).toContain('"Helped" writes it later in the tick');
  });

  it("is read through plugins, each one's dependencies ahead of its own and the app's own last", () => {
    const Motion = Plugin.make("or/Motion", { systems: [Move] });
    // A plugin's own list is checked where the plugin is made.
    Plugin.make(
      "or/Backwards",
      // @ts-expect-error a watcher listed ahead of what it watches
      { systems: [Trail, Move] }
    );
    // What a plugin depends on runs ahead of it.
    const Trails = Plugin.make("or/Trails", {
      plugins: [Motion],
      systems: [Trail],
    });
    App.define({ plugins: [Trails] });
    // A plugin that two others depend on runs once, where it is first met,
    // and is not taken for a second, later writer.
    const Other = Plugin.make("or/Other", {
      plugins: [Motion],
      systems: [Bleed],
    });
    App.define({ plugins: [Trails, Other] });
    // A plugin's systems run ahead of the app's own.
    const Watching = Plugin.make("or/Watching", { systems: [Trail] });
    App.define(
      // @ts-expect-error the plugin's watcher runs ahead of the app's writer
      { plugins: [Watching], systems: [Move] }
    );
    App.define(
      // @ts-expect-error a plugin listed ahead of the one whose system it watches
      { plugins: [Watching, Motion] }
    );
    App.define({ plugins: [Motion, Watching] });
    expect(Trails.systems).toEqual([Trail]);
  });

  it("refuses a list it cannot read the order of, when the order would matter", () => {
    // A list that is not written out where it is given is in no order the
    // compiler knows.
    const listed = [Trail, Move];
    App.define(
      // @ts-expect-error one watches what the other writes, in an order unknown
      { systems: listed }
    );
    // The order of systems that write and watch nothing of each other's
    // does not matter, and is not asked for.
    const harmless = [Bleed, Move];
    App.define({ systems: harmless });
    const atPost = Trail.pipe(System.inStage("postUpdate"));
    App.define({ systems: [Move, atPost] });
    expect(listed.length + harmless.length).toBe(4);
  });

  it("reads a list of hundreds of systems", () => {
    type Repeat<
      T,
      N extends number,
      Out extends readonly T[] = readonly [],
    > = Out["length"] extends N ? Out : Repeat<T, N, readonly [...Out, T]>;
    type Busy = System.System<
      never,
      Query.Writes<"or/Position"> | Query.Watches<"or/Health">,
      string,
      "update",
      undefined
    >;
    const none: Said<Repeat<Busy, 300>> = "nothing";
    expect(none).toBe("nothing");
  });
});

describe("what a system spawns and sets", () => {
  const Dot = Component.tag("or/Dot");
  const NewDots = Query.all(Dot).pipe(Query.added(Dot));
  /** Spawns a dot each tick. */
  const Grow = System.tick("Grow", function* () {
    (yield* Commands.spawns(Dot)).spawn(Dot);
  });
  /** A system that notes how many new dots it found, each tick. */
  const count = (seen: number[]) =>
    System.tick("Count", function* () {
      seen.push((yield* NewDots).entities().length);
    });
  const Count = count([]);
  const tick3 = (app: App.Any): void => {
    for (let n = 0; n < 3; n++) {
      app.tick(1);
    }
  };

  it("is named where the commands are asked for, and a component that was not named does not compile", () => {
    let spawned: Entity | undefined;
    const Shoot = System.tick("Shoot", function* () {
      const commands = yield* Commands.spawns(Dot, Position);
      spawned = commands.spawn(Dot, Position.of({ x: 3 }));
      commands.add(spawned, Position.of({ x: 4 }));
      commands.spawn(
        // @ts-expect-error the commands were not asked for health
        Health.of({ hp: 1 })
      );
      commands.add(
        spawned,
        // @ts-expect-error nor to add it
        Health
      );
    });
    const Reap = System.tick("Reap", function* () {
      // Commands asked for with nothing named despawn and remove.
      const commands = yield* Commands;
      commands.remove(spawned!, Dot);
      commands.spawn(
        // @ts-expect-error and spawn nothing
        Dot
      );
    });
    withApp(App.make(App.define({ systems: [Shoot, Reap] })), (app) => {
      app.tick(1);
      expect(app.world.get(spawned!, Position)).toEqual({ x: 4 });
      expect(app.world.has(spawned!, Dot)).toBe(false);
    });
  });

  it("puts a spawn in the order of the list: a system that watches for it is listed after", () => {
    const seen: number[] = [];
    withApp(App.make(App.define({ systems: [Grow, count(seen)] })), tick3);
    expect(seen).toEqual([1, 1, 1]);

    App.define(
      // @ts-expect-error a watcher of what is added, listed ahead of what spawns it
      { systems: [Count, Grow] }
    );
    const said: Said<readonly [typeof Count, typeof Grow]> =
      '"Count" watches "or/Dot" with Query.added, and "Grow" spawns or adds it later in the tick, so "Count" would react a tick late. List "Count" after "Grow", or place it in a later stage.';
    expect(said).toContain('"Grow" spawns or adds it');
    // What it refuses is what happens.
    const late: number[] = [];
    const unread: readonly System.System<never, BuiltIn>[] = [
      count(late),
      Grow,
    ];
    withApp(App.make(App.define({ systems: unread })), tick3);
    expect(late).toEqual([0, 1, 1]);

    // A component an entity gains counts as written, so Query.changed
    // watches a spawn too.
    const Place = System.tick("Place", function* () {
      (yield* Commands.spawns(Position)).spawn(Position.of({ x: 0 }));
    });
    App.define(
      // @ts-expect-error a watcher of what is written, listed ahead of what spawns it
      { systems: [Trail, Place] }
    );
    // A query that writes a component adds it to no entity.
    App.define({ systems: [Count, Move] });
  });

  it("names what it sets where the world is asked for, and a component that was not named does not compile", () => {
    let target: Entity | undefined;
    const Heal = System.tick("Heal", function* () {
      const world = yield* World.writes(Health);
      world.set(target!, Health, { hp: world.get(target!, Health)!.hp + 1 });
      world.set(
        target!,
        // @ts-expect-error the world was not asked for positions
        Position,
        { x: 1 }
      );
    });
    const Look = System.tick("Look", function* () {
      // The world asked for with nothing named reads.
      const world = yield* World;
      world.get(target!, Health);
      world.set(
        target!,
        // @ts-expect-error and sets nothing
        Health,
        { hp: 0 }
      );
      // @ts-expect-error The set of entities changes through Commands alone.
      world.spawn(Dot);
      // @ts-expect-error And a query is asked for, not taken from the world.
      world.view(Healths);
    });
    expect(Look.name).toBe("Look");
    withApp(App.make(App.define({ systems: [Heal] })), (app) => {
      target = app.world.spawn(Health.of({ hp: 1 }));
      app.tick(1);
      expect(app.world.get(target, Health)).toEqual({ hp: 2 });
    });
  });

  it("puts a set in the order of the list, as a query's write is", () => {
    const Jolt = System.tick("Jolt", function* () {
      for (const entity of (yield* Query.all(Position)).entities()) {
        (yield* World.writes(Position)).set(entity, Position, { x: 9 });
      }
    });
    App.define({ systems: [Jolt, Trail] });
    App.define(
      // @ts-expect-error a watcher listed ahead of the system that sets what it watches
      { systems: [Trail, Jolt] }
    );
    const said: Said<readonly [typeof Trail, typeof Jolt]> =
      '"Trail" watches "or/Position" with Query.changed, and "Jolt" writes it later in the tick, so "Trail" would react a tick late. List "Trail" after "Jolt", or place it in a later stage.';
    expect(said).toContain('"Jolt" writes it');
  });
});
