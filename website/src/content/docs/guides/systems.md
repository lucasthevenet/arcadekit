---
title: "Systems"
description: "A system is your game's logic: one Effect per tick, with plain loops inside. Learn how systems are ordered, staged, run conditionally, and use random numbers."
---

A **system** is your game's logic: one Effect per tick, with plain loops inside. This guide covers system order, stages, running conditionally, random numbers, and declaring what a system touches.

## Creating a system

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

The body gets what it needs with `yield*`: queries, singletons, events, `Time`, `Random`, `Commands`, `World`, and any service of your own. Anything it needs that no plugin provides becomes a requirement of the app, and a missing one is a compile error.

A system finishes within its tick: a system that waits throws, and the error names it. Work that spans many ticks keeps its place in the world, and a system moves it on each tick, as the next section shows. A system changes which entities exist only through `Commands`, and reacts to changes with a [change query](queries.md) rather than by comparing against a copy it keeps. It issues actions with the [`Actions` service](events-and-actions.md), which isn't logged from a tick, since a replay's own systems issue the action again.

## Work that takes many ticks

A wave of enemies, a cutscene or a tutorial step takes many ticks. A system doesn't wait through them: it keeps where the work is in the world, in a component, a singleton or a [state](states.md), and moves it on each tick. This fountain sprays five waves, half a second of game time apart:

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

Since the fountain's place is in the world, a [save](saving-and-loading.md) holds it, a replay or a rewind picks it up where it was, and the world's hash covers it. A game that [ticks only when needed](running-a-game.md#ticking-only-when-needed) keeps ticking while the fountain counts down, since each tick changes the world.

## Ordering

Systems run in the order they are listed. A plugin's systems run before the app's own, and a plugin's dependencies' systems before the plugin's.

The list is the only order within a stage, so a system that reads what another writes is listed after it. To run a system ahead of one from a plugin you depend on, place it in an earlier [stage](#stages).

You don't declare what a system reads and writes. The compiler knows what each system's queries write and watch from the queries it yields, and checks the list with it. A system that [watches a component for changes](queries.md#change-detection), listed ahead of a system that writes that component in the same tick, would react a tick late, so that list doesn't compile:

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
- Hooks, handlers, and systems of the frame and input stages run at another moment, and are not checked against the tick's systems.
- Write the list where you give it to `App.define` or `Plugin.make`, and write a system's stage out in `System.inStage`. A list or a stage held in a variable of a wider type has no order the compiler can read, and is refused when the order would matter.
- The compiler knows what a system changes from what it requests: a query that names a component with `Query.writes`, `World.writes`, and `Commands.spawns`. A component an entity gains counts as written, so a system that watches with `Query.changed` or `Query.added` is listed after the systems that spawn or add the component.
- `Query.removed` isn't checked. A despawn doesn't say which components its entity had, so a system that reads removals, listed ahead of the system that despawns, reads them a tick late.

## Stages

A tick has three stages, `"preUpdate"`, `"update"` and `"postUpdate"`, each run in full before the next. A frame has three too, `"preFrame"`, `"frame"` and `"postFrame"`. The input stage runs before each tick. `System.tick` makes a system of `"update"`, `System.frame` a system of `"frame"`, and `System.input` a system of the input stage. `System.inStage` moves one inside its own group:

```ts sketch
const Draw = System.frame("game/Draw", function* () {
  /* … */
});
```

`"preFrame"` is for what every frame system depends on, such as which assets are loaded, and `"postFrame"` is for what needs everything drawn first, such as a renderer's final pass.

The frame and input stages are outside the simulation, and a replay runs neither. An action issued there with `Actions.enqueue` is therefore logged, like any input from outside.

`app.systemOrder` and `app.frameOrder` list systems in running order. See [ticks and frames](../concepts/ticks-and-frames.md) for what each stage allows.

## Running conditionally

`System.runIf(condition)` runs a system only on ticks where the condition holds. A condition is any Effect that returns a boolean. The most common one checks a state:

```ts sketch
const Movement = System.tick("game/Movement", function* () {
  /* … */
}).pipe(System.runIf(State.is(Phase, "playing")));
```

A system that doesn't run sees nothing of what happened while it was off: no event from the ticks it skipped, and none of what its change queries would have visited in them. When it runs again, it reads the state it needs.

A system that keeps something outside itself up to date, such as music or a view, can declare what to do while it doesn't run with `System.otherwise(effect)`. See [states](states.md).

## Random numbers

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
- It isn't suitable for secrets: a few outputs reveal the rest.

## Read more

- [`System`](/reference/arcadekit/System) and [`State`](/reference/arcadekit/State) in the API reference, with [`Random`](/reference/arcadekit/Services#random).
