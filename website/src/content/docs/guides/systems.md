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
  (yield* Moving).each((position, velocity) => {
    position.x += velocity.x * delta;
  });
});
```

The body gets what it needs with `yield*`: queries, singletons, states, events, resources, `Time`, `Random`, `Commands` and `World`. A system of the frame or the input stage can also require a service of your own. Anything a system needs that no plugin provides becomes a requirement of the app, and a missing one is a compile error.

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
  const spray = yield* Spray.writes;
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

## Order systems

Systems run in the order they are listed. A plugin's systems run before the app's own, and a plugin's dependencies' systems run before the plugin's.

The list is the only order within a stage. List a system that reads what another writes after it. To run a system ahead of one from a plugin you depend on, place it in an earlier [stage](#place-a-system-in-a-stage).

You don't declare what a system reads and writes. The compiler learns what each system writes and watches from the queries it yields, and checks the list against it. A system that [watches a component for changes](queries.md#visit-only-what-changed) reacts a tick late when it is listed ahead of a system that writes that component, so that list doesn't compile:

```ts sketch
const Moving = Query.all(Position).pipe(Query.writes(Position));
const Moved = Query.all(Position).pipe(Query.changed(Position));

const Move = System.tick("game/Move", function* () {
  (yield* Moving).each((position) => {
    position.x += 1;
  });
});
const Trail = System.tick("game/Trail", function* () {
  (yield* Moved).each((position) => {});
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
- The check doesn't cover `Query.removed`. A despawn doesn't say which components its entity had. A system that reads removals therefore reads them a tick late when it is listed ahead of the system that despawns.

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

## Run a system only when a condition holds

`System.runIf(condition)` runs a system only when the condition holds. A condition is any Effect that returns a boolean, and can read anything a system can. The most common one checks a [state](states.md):

```ts sketch
const Movement = System.tick("game/Movement", function* () {
  /* … */
}).pipe(System.runIf(State.is(Phase, "playing")));
```

- Given several conditions, the system runs when all of them hold. They are checked in order until one fails.
- A condition's requirements and errors become the system's.
- A system without a condition checks nothing. A condition costs about 0.35 µs per tick, and a system that doesn't run costs that and nothing more.
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
  (yield* Sparks).each((spark) => {
    spark.x += random.next() - 0.5; // from 0 inclusive to 1 exclusive
  });
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
- `int` gives every value equal probability, and `shuffle` every permutation.
- The generator's state is four numbers in the world, so it is part of the world's hash and of a save. A replay with the same seed draws the same numbers, and a loaded save resumes the sequence where it was.
- Inside an app, Effect's own `Random` module is seeded from the same generator, so `Random.next` from `"effect"`, and anything built on it, replays too. It costs an Effect per draw, so don't use it in loops.
- In the frame and input stages, `Random` is a separate generator that isn't part of the world, so rendering can be random without changing the game.
- Don't use it for secrets. A few outputs reveal the rest.

## Read more

- [`System`](/reference/arcadekit/System) and [`State`](/reference/arcadekit/State) in the API reference, with [`Random`](/reference/arcadekit/Services#random).
