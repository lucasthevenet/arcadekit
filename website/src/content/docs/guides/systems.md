---
title: "Systems"
description: "A system is your game's logic: one Effect per tick, with plain loops inside. Learn how systems are ordered, staged, run conditionally, and use random numbers."
---

A **system** is your game's logic. It runs as one Effect per tick, with plain loops inside.

## Create a system

```ts
import { Component, Field, Query, System, Time } from "arcadekit";

const Position = Component.define("game/Position", { x: Field.f32 });
const Velocity = Component.define("game/Velocity", { x: Field.f32 });
const Moving = Query.all(Position, Velocity).pipe(Query.writes(Position));

const Movement = System.tick("game/Movement", function* () {
  const { delta } = yield* Time;
  (yield* Query.View(Moving)).each((position, velocity) => {
    position.x += velocity.x * delta;
  });
});
```

The body asks for what it needs with `yield*`. A query, a singleton, a state and an event are plain definitions, and a capability applied to one gives what the system uses: `Query.View(Moving)` a query's view, `Singleton.Read(Score)` and `Singleton.Write(Score)` a singleton's value, `State.Reader(Phase)` and `State.Setter(Phase)` a state, and `Event.Reader(Collided)` and `Event.Emitter(Collided)` an event. A resource and the services `Time`, `Random`, `Commands` and `World` are yielded as they are. A system of the frame or the input stage can also require a service of your own. Anything a system needs that no plugin provides becomes a requirement of the app, and a missing one is a compile error.

- A system finishes within its tick. A system that waits throws, and the error names it.
- A system changes which entities exist only through `Commands`.
- A system reacts to changes with a [change query](queries.md#visit-only-what-changed), not by comparing against a copy it keeps.
- A system issues actions with the [`Actions` service](events-and-actions.md#issue-an-action-from-the-game). An action issued from a tick isn't logged, because a replay's own systems issue it again.

## Spread work over many ticks

A wave of enemies, a cutscene or a tutorial step takes many ticks. A system doesn't wait through them. It keeps the work's progress in the world, in a component, a singleton or a [state](states.md), and advances it each tick. This fountain sprays five waves, half a second of game time apart:

```ts
import { Commands, Component, Field, Singleton, System, Time } from "arcadekit";

const Velocity = Component.define("game/Velocity", { y: Field.f32 });
const Spray = Singleton.define(
  "game/Spray",
  { wave: Field.u8, wait: Field.f32 },
  { wave: 0, wait: 0 }
);

const Fountain = System.tick("game/Fountain", function* () {
  const spray = yield* Singleton.Write(Spray);
  if (spray.wave >= 5) {
    return;
  }
  spray.wait -= (yield* Time).delta;
  if (spray.wait > 0) {
    return;
  }
  spray.wave += 1;
  spray.wait = 0.5;
  (yield* Commands.spawns(Velocity)).spawn(Velocity.of({ y: spray.wave }));
});
```

The fountain's progress is in the world, so a [save](saving-and-loading.md) holds it, a replay or a rewind picks it up where it was, and the world's hash covers it. A game that [ticks only when needed](running-a-game.md#tick-only-when-needed) keeps ticking while the fountain counts down, because each tick changes the world.

## Share a rule between systems with a plain function

A rule that a system and an action's handler both apply is a plain function. It takes what the system was handed, typed for what the function uses:

```ts
import {
  Action,
  Commands,
  Component,
  EntityId,
  Field,
  Query,
  Singleton,
  System,
  World,
} from "arcadekit";
import type { Entity, Spawning, WritingWorld } from "arcadekit";
import { Schema } from "effect";

const Health = Component.define("game/Health", { hp: Field.i32 });
const Position = Component.define("game/Position", { x: Field.f32 });
const Spark = Component.tag("game/Spark");
const Score = Singleton.define("game/Score", { hits: Field.u32 }, { hits: 0 });

const strike = (
  world: WritingWorld<"game/Health">,
  commands: Spawning<"game/Spark">,
  score: Singleton.Write<typeof Score>,
  target: Entity
): void => {
  world.set(target, Health, { hp: world.get(target, Health)!.hp - 1 });
  commands.spawn(Spark);
  score.hits += 1;
};

const Strike = Action.define(
  "game/Strike",
  Schema.Struct({ target: EntityId })
);
export const struck = Action.handler(Strike, function* ({ target }) {
  strike(
    yield* World.writes(Health),
    yield* Commands.spawns(Spark),
    yield* Singleton.Write(Score),
    target
  );
});

const Falling = Query.all(Position).pipe(Query.with(Health));

export const Fall = System.tick("game/Fall", function* () {
  const world = yield* World.writes(Health, Position);
  const commands = yield* Commands.spawns(Spark, Position);
  const score = yield* Singleton.Write(Score);
  for (const target of (yield* Query.View(Falling)).entities()) {
    if (world.get(target, Position)!.x < 0) {
      strike(world, commands, score, target);
      world.set(target, Position, { x: 0 });
    }
  }
});
```

- `WritingWorld<N>` is the world that sets the components named `N`. A world that sets more is one too, so `Fall`'s world, which sets health and positions, is a world that sets health. One that sets less, or only reads, doesn't compile.
- `Spawning<N>` is the same for commands, and `Singleton.Write<typeof Score>` is what `yield* Singleton.Write(Score)` gives.
- The function asks for nothing with `yield*`, so it adds nothing to a system's requirements. What the system asked for is what the [order check](#order-systems) reads, so the system names what the function writes.

## Order systems

Systems run in the order they are listed. A plugin's systems run before the app's own, and a plugin's dependencies' systems run before the plugin's.

The list is the only order within a stage. List a system that reads what another writes after it. To run a system ahead of one from a plugin you depend on, place it in an earlier [stage](#place-a-system-in-a-stage).

You don't declare what a system reads and writes. The compiler learns what each system writes and watches from the queries it yields, and checks the list against it. A system that [watches a component for changes](queries.md#visit-only-what-changed) reacts a tick late when it is listed ahead of a system that writes that component, so that list doesn't compile:

```ts sketch
const Moving = Query.all(Position).pipe(Query.writes(Position));
const Moved = Query.all(Position).pipe(Query.changed(Position));

const Move = System.tick("game/Move", function* () {
  (yield* Query.View(Moving)).each((position) => {
    position.x += 1;
  });
});
const Trail = System.tick("game/Trail", function* () {
  (yield* Query.View(Moved)).each((position) => {});
});

App.define({ systems: [Move, Trail] }); // Trail sees each move in its tick
App.define({ systems: [Trail, Move] }); // doesn't compile
```

The error names both systems and says which to list after the other:

```text
"game/Trail" watches "game/Position" with Query.changed, and "game/Move" writes it later in the tick, so "game/Trail" would react a tick late. List "game/Trail" after "game/Move", or place it in a later stage.
```

- The check follows the order a tick runs: stage by stage, a plugin's dependencies before the plugin, and plugins before the app's own systems.
- Hooks, handlers, and systems of the frame and input stages run at another moment. The check doesn't compare them with the tick's systems.
- Write the list where you give it to `App.define` or `Plugin.make`. Write a system's stage out in `System.inStage`. The compiler can't read the order of a list or a stage held in a variable of a wider type, and refuses it when the order would matter.
- The compiler learns what a system changes from what it requests: a query that names a component with `Query.writes`, `World.writes`, and `Commands.spawns`. A component an entity gains counts as written, so list a system that watches with `Query.changed` or `Query.added` after the systems that spawn or add the component.
- The check doesn't cover `Query.Removed`. A despawn doesn't say which components its entity had. A system that reads removals therefore reads them a tick late when it is listed ahead of the system that despawns.

## Place a system in a stage

`System.tick` makes a system of the tick's `"update"` stage, `System.frame` a system of the frame's `"frame"` stage, and `System.input` a system of the input stage. `System.inStage` moves a tick system to `"preUpdate"` or `"postUpdate"`, and a frame system to `"preFrame"` or `"postFrame"`:

```ts sketch
const Gravity = System.tick("game/Gravity", function* () {
  /* … */
}).pipe(System.inStage("preUpdate"));
```

- Each stage runs in full before the next, and the list orders the systems within a stage.
- `System.inStage` moves a system only within the group it was made in. A tick system given `"preFrame"` doesn't compile, and neither does any stage for an input system.
- `app.systemOrder`, `app.frameOrder` and `app.inputOrder` list the systems of the tick, the frame and the input stage in running order.

[Ticks and frames](../concepts/ticks-and-frames.md) explains what each stage is for and what it may change.

## Keep something from one frame to the next

What a frame or an input system keeps between frames, such as a camera's angle, is no part of the game. `System.local` keeps it for each app:

```ts
import { Frame, System } from "arcadekit";

const Orbit = System.local(() => ({ angle: 0 }));

const Camera = System.frame("game/Camera", function* () {
  const orbit = yield* System.Kept(Orbit);
  orbit.angle += (yield* Frame).delta;
});
```

- Each app has its own value, made the first time one of its systems asks for the local, and let go of when the app closes. `System.local(make, release)` passes it to `release` then.
- Every system that asks for the local shares its value, so an input system can set what a frame system reads.
- The value is outside the world: a save, the hash and a rewind leave it as it is.
- A system of the tick, a hook or a handler that asks for a local doesn't compile. What the tick keeps belongs in the world.
- Keep it in a local and not in a variable of the module, which every app of the game would share, and none would let go of.

## Run a system only when a condition holds

`System.runIf(condition)` runs a system only when the condition holds. A condition is any Effect that returns a boolean, and can read anything a system can. The most common one checks a [state](states.md):

```ts sketch
const Movement = System.tick("game/Movement", function* () {
  /* … */
}).pipe(System.runIf(State.is(Phase, "playing")));
```

- Given several conditions, the system runs when all of them hold. They are checked in order until one fails.
- A condition's requirements and errors become the system's.
- A system without a condition checks nothing. `State.is` costs a little less than a system that runs and does nothing, and a system that doesn't run costs that and nothing more. The [performance guide](performance.md#idle-ticks-and-frames) has the numbers.
- A system of the frame or the input stage takes a condition too, checked each time its stage runs.

A system that doesn't run doesn't read, and sees nothing of what happened while it was off. The events from the ticks it skipped are gone when it runs again, and its change queries skip what changed in them. When it runs again, have it read the state it needs with an ordinary query or a singleton, rather than count on hearing of every change.

A system that keeps something outside the world up to date, such as music or a view, leaves it as it last was while it doesn't run. `System.otherwise(effect)` gives the system something to do instead, on each tick its condition fails. Music uses it to stop music that is no longer requested, and a view uses it to return to its initial value. The effect runs as the system, in its stage. In a tick its commands are applied, and in a frame it can change nothing.

## Draw random numbers

`Random` is the only source of randomness in a simulation:

```ts
import { App, Component, Field, Query, Random, System } from "arcadekit";
import { Effect } from "effect";

const Spark = Component.define("game/Spark", { x: Field.f32 });
const Sparks = Query.all(Spark).pipe(Query.writes(Spark));

const Scatter = System.tick("game/Scatter", function* () {
  const random = yield* Random;
  (yield* Query.View(Sparks)).each((spark) => {
    spark.x += random.next() - 0.5; // from 0 inclusive to 1 exclusive
  });
  const speed = random.range(2, 5); // from 2 inclusive to 5 exclusive
  const critical = random.chance(0.1); // true one time in ten
  const roll = random.int(1, 6); // an integer, both ends inclusive
  const cue = random.pick(["thud", "clang"]);
  const deck = random.shuffle([1, 2, 3, 4]); // in place
});

const program = Effect.gen(function* () {
  const app = yield* App.make(App.define({ systems: [Scatter] }), {
    seed: 2024,
  });
});
```

- Its methods are plain calls, so they are fine inside a loop. A draw costs about 4 ns.
- The same seed produces the same numbers on every machine and in every JavaScript engine. Without a seed, the seed is 0, so a game stays reproducible until you pass a seed from outside, such as the current time at the entry point.
- `int` gives every value equal probability, and `shuffle` every permutation. `range` and `chance` each draw one number, as `next` does.
- The generator's state is four numbers in the world, so it is part of the world's hash and of a save. A replay with the same seed draws the same numbers, and a loaded save resumes the sequence where it was.
- Inside an app, Effect's own `Random` module is seeded from the same generator, so `Random.next` from `"effect"`, and anything built on it, replays too. It costs an Effect per draw, so don't use it in loops.
- In the frame and input stages, `Random` is a separate generator that isn't part of the world, so rendering can be random without changing the game.
- Don't use it for secrets. A few outputs reveal the rest.

## Read more

- [`System`](/reference/arcadekit/System) and [`State`](/reference/arcadekit/State) in the API reference, with [`Random`](/reference/arcadekit/Services#random).
