import { Effect, Schema } from "effect";
import { assert, describe, expect, expectTypeOf, it } from "vitest";

import type { ComponentDef, Spawned } from "../src/index";
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
import type { Adds } from "../src/Query";
import { withApp } from "./peers";
import { placedIn } from "./placed";

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

/** What the compiler says of a list, or that it says nothing. */
type Said<S extends readonly System.System<unknown, unknown>[]> = [
  System.Misordered<S>,
] extends [never]
  ? "nothing"
  : System.Misordered<S>;

const LATE =
  '"Trail" watches "or/Position" with Query.changed, and "Move" writes it later in the tick, so "Trail" would react a tick late. List "Trail" after "Move", or place it in a later stage.';

const NOT_TUPLE =
  "List systems, handlers and plugins as a literal list, [a, b], so the compiler can read their names and order.";

describe("the order of systems", () => {
  it("has a system that watches a component react in the tick it is written, and a list the other way round does not compile", () => {
    // Three ticks of one entity, moved on the second.
    const One = Plugin.make("or/One", {
      setup: Effect.gen(function* () {
        (yield* Commands.spawns(Position)).spawn(Position.of({ x: 0 }));
      }),
    });
    const play = (app: App.Any): void => {
      for (let n = 0; n < 3; n++) {
        app.tick(1);
      }
    };
    // Listed after what it watches: all of it on its first visit, then the
    // move in the tick it is made.
    const seen: number[] = [];
    withApp(
      App.make(App.define({ plugins: [One], systems: [Move, trail(seen)] })),
      play
    );
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

    // What it refuses is what happens: the same list runs the watcher a tick
    // behind.
    const late: number[] = [];
    const refused = App.define(
      // @ts-expect-error a watcher listed ahead of what it watches
      { plugins: [One], systems: [trail(late), Move] }
    );
    withApp(App.make(refused), play);
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

  it("refuses a list of systems, handlers or plugins that is not written out where it is given", () => {
    // Its names and order are unknown to the compiler, even when they would
    // not matter.
    const harmless = [Bleed, Move];
    App.define(
      // @ts-expect-error a list of systems that is not a tuple
      { systems: harmless }
    );
    Plugin.make(
      "or/Harmless",
      // @ts-expect-error in a plugin too
      { systems: harmless }
    );
    const Tap = Action.define("or/Tapped", Schema.Struct({}));
    const handlers = [Action.handler(Tap, function* () {})];
    App.define(
      // @ts-expect-error a list of handlers that is not a tuple
      { handlers }
    );
    const plugins = [Plugin.make("or/Lone", {})];
    App.define(
      // @ts-expect-error a list of plugins that is not a tuple
      { plugins }
    );
    Plugin.make(
      "or/Above",
      // @ts-expect-error a plugin's own plugins too
      { plugins }
    );
    const said: Said<typeof harmless> = NOT_TUPLE;
    expect(said).toBe(NOT_TUPLE);
    App.define({ systems: [Bleed, Move] });
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
    let spawned: Spawned | undefined;
    const Shoot = System.tick("Shoot", function* () {
      const commands = yield* Commands.spawns(Dot, Position);
      const shot = commands.spawn(Dot, Position.of({ x: 3 }));
      spawned = shot;
      commands.add(shot, Position.of({ x: 4 }));
      commands.spawn(
        // @ts-expect-error the commands were not asked for health
        Health.of({ hp: 1 })
      );
      commands.add(
        shot,
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
    withApp(App.make(App.define({ systems: [Shoot, Reap] })), (app, world) => {
      app.tick(1);
      assert(spawned !== undefined);
      const shot = placedIn(world, spawned);
      expect(world.get(shot, Position)).toEqual({ x: 4 });
      expect(world.has(shot, Dot)).toBe(false);
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
    const refused = App.define(
      // @ts-expect-error a watcher of what is added, listed ahead of what spawns it
      { systems: [count(late), Grow] }
    );
    withApp(App.make(refused), tick3);
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
    let target: Spawned | undefined;
    const Heal = System.tick("Heal", function* () {
      const world = yield* World.writes(Health);
      assert(target !== undefined);
      const patient = placedIn(world, target);
      world.set(patient, Health, { hp: world.get(patient, Health)!.hp + 1 });
      world.set(
        patient,
        // @ts-expect-error the world was not asked for positions
        Position,
        { x: 1 }
      );
    });
    const Look = System.tick("Look", function* () {
      // The world asked for with nothing named reads.
      const world = yield* World;
      assert(target !== undefined);
      const patient = placedIn(world, target);
      world.get(patient, Health);
      // @ts-expect-error and has no set: World.writes gives one
      world.set(patient, Health, { hp: 0 });
      // @ts-expect-error The set of entities changes through Commands alone.
      world.spawn(Dot);
      // @ts-expect-error And a query is asked for, not taken from the world.
      world.view(Healths);
    });
    expect(Look.name).toBe("Look");
    const Patient = Plugin.make("or/Patient", {
      setup: Effect.gen(function* () {
        target = (yield* Commands.spawns(Health)).spawn(Health.of({ hp: 1 }));
      }),
    });
    withApp(
      App.make(App.define({ plugins: [Patient], systems: [Heal] })),
      (app, world) => {
        app.tick(1);
        assert(target !== undefined);
        expect(world.get(placedIn(world, target), Health)).toEqual({ hp: 2 });
      }
    );
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

describe("what a spawn fills in", () => {
  const Size = Component.define("or/Size", { s: Field.f32 });
  const Rock = Component.tag("or/Rock", { requires: [Position, Size] });
  type Needs<T> =
    T extends Effect.Effect<unknown, unknown, infer R> ? R : never;
  const NewPositions = Query.all(Position).pipe(Query.added(Position));
  const watches = (seen: number[]) =>
    System.tick("Watch", function* () {
      seen.push((yield* NewPositions).entities().length);
    });
  const Watch = watches([]);
  const Quarry = System.tick("Quarry", function* () {
    (yield* Commands.spawns(Rock)).spawn(Rock);
  });

  it("is in the requirements of a system that spawns, so a watcher of it is listed after", () => {
    expectTypeOf<
      Needs<ReturnType<typeof Commands.spawns<[typeof Rock]>>>
    >().toEqualTypeOf<
      Commands | Adds<"or/Rock"> | Adds<"or/Position"> | Adds<"or/Size">
    >();
    const seen: number[] = [];
    withApp(App.make(App.define({ systems: [Quarry, watches(seen)] })), (app) =>
      app.tick(1)
    );
    expect(seen).toEqual([1]);
    App.define(
      // @ts-expect-error the watcher would see the filled position a tick late
      { systems: [Watch, Quarry] }
    );
    // What is filled in is not spawned alone by these commands.
    System.tick("Alone", function* () {
      const commands = yield* Commands.spawns(Rock);
      commands.spawn(
        // @ts-expect-error the commands were not asked for positions
        Position.of({ x: 1 })
      );
    });
  });

  it("goes with a state's scoped tag, and the order check sees both", () => {
    const playing = State.scoped(Phase, "playing");
    const NewInPlay = Query.all(playing).pipe(Query.added(playing));
    const Scoped = System.tick("Scoped", function* () {
      (yield* Commands.spawns(Rock, playing)).spawn(Rock, playing);
    });
    const inPlay: number[] = [];
    const WatchPlay = System.tick("WatchPlay", function* () {
      inPlay.push((yield* NewInPlay).entities().length);
    });
    const seen: number[] = [];
    withApp(
      App.make(App.define({ systems: [Scoped, watches(seen), WatchPlay] })),
      (app) => app.tick(1)
    );
    expect([seen, inPlay]).toEqual([[1], [1]]);
    App.define(
      // @ts-expect-error the filled position, watched ahead of the spawn
      { systems: [Watch, Scoped] }
    );
    App.define(
      // @ts-expect-error the scoped tag, watched ahead of the spawn
      { systems: [WatchPlay, Scoped] }
    );
  });

  it("is not hidden by a component whose requirements the compiler can't read", () => {
    const Loose: ComponentDef<{}, "table", "or/Loose"> =
      Component.tag("or/Loose");
    expectTypeOf<
      Needs<ReturnType<typeof Commands.spawns<[typeof Loose, typeof Rock]>>>
    >().toEqualTypeOf<
      | Commands
      | Adds<"or/Loose">
      | Adds<"or/Rock">
      | Adds<"or/Position">
      | Adds<"or/Size">
    >();
  });
});
