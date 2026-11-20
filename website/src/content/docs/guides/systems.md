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

const Movement = System.make("game/Movement", function* () {
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

const Fountain = System.make("game/Fountain", function* () {
  const spray = yield* Spray;
  if (spray.wave >= 5) {
    return;
  }
  spray.wait -= (yield* Time).delta;
  if (spray.wait > 0) {
    return;
  }
  spray.wave += 1;
  spray.wait = 0.5;
  (yield* Commands).spawn(Velocity.of({ y: spray.wave }));
});
```

Since the fountain's place is in the world, a [save](saving-and-loading.md) holds it, a replay or a rewind picks it up where it was, and the world's hash covers it. A game that [ticks only when needed](#requesting-ticks) needs the fountain to ask for its next tick while it waits.

## Ordering

Systems run in the order they are listed. A plugin's systems run before the app's own, and a plugin's dependencies' systems before the plugin's.

`System.after(other)` and `System.before(other)` declare that a system runs after or before another:

```ts sketch
const Expiry = System.make("game/Expiry", function* () {
  /* … */
}).pipe(System.after(Movement));
```

These order systems within a stage. Declaring an order that already holds changes nothing, so declare it wherever it matters.

Each system keeps its place in the list unless another system must run before it, in which case that one moves to just ahead of it. The system that moved now runs ahead of everything listed between the two, so it may now run before a system it reads from, with no error. Declare that order too.

## Stages

A tick has three stages, `"preUpdate"`, `"update"` and `"postUpdate"`, each run in full before the next. A frame has three too, `"preFrame"`, `"frame"` and `"postFrame"`. The input stage runs before each tick. A system runs in `"update"` unless you place it elsewhere:

```ts sketch
const Draw = System.make("game/Draw", function* () {
  /* … */
}).pipe(System.inStage("frame"));
```

`"preFrame"` is for what every frame system depends on, such as which assets are loaded, and `"postFrame"` is for what needs everything drawn first, such as a renderer's final pass.

The frame and input stages are outside the simulation, and a replay runs neither. An action issued there with `Actions.enqueue` is therefore logged, like any input from outside.

`app.systemOrder` and `app.frameOrder` list systems in running order. See [ticks and frames](../concepts/ticks-and-frames.md) for what each stage allows.

## Running conditionally

`System.runIf(condition)` runs a system only on ticks where the condition holds. A condition is any Effect that returns a boolean. The most common one checks a state:

```ts sketch
const Movement = System.make("game/Movement", function* () {
  /* … */
}).pipe(System.runIf(State.is(Phase, "playing")));
```

A system that doesn't run sees nothing of what happened while it was off: no event from the ticks it skipped, and none of what its change queries would have visited in them. When it runs again, it reads the state it needs.

A system that keeps something outside itself up to date, such as music or a view, can declare what to do while it doesn't run with `System.otherwise(effect)`. See [states](states.md).

## Requesting ticks

A game that [ticks only when needed](running-a-game.md) rests when nothing is pending, and the app sees actions, states and events as pending work. A system with work to do on every tick for a while, such as a countdown or a body in flight, is none of those, so it requests the next tick itself on every tick it has more to do:

```ts
import { Field, Singleton, System, Ticks, Time } from "arcadekit";

const Clock = Singleton.define("game/Clock", { left: Field.f32 }, { left: 3 });

const Countdown = System.make("game/Countdown", function* () {
  const clock = yield* Clock;
  if (clock.left > 0) {
    clock.left -= (yield* Time).delta;
    (yield* Ticks).more(); // not at rest: the next tick is needed
  }
});
```

Nothing distinguishes a countdown system that never requests a tick from one with nothing to do: it stops when the game rests, with no error. In a game that ticks in real time, `more` does nothing, so call it in any system that might run in a game that rests. Handlers request ticks the same way.

## Random numbers

`Random` is the only source of randomness in a simulation:

```ts
import { App, Component, Field, Query, Random, System } from "arcadekit";
import { Effect } from "effect";

const Spark = Component.define("game/Spark", { x: Field.f32 });
const Sparks = Query.all(Spark).pipe(Query.writes(Spark));

const Scatter = System.make("game/Scatter", function* () {
  const random = yield* Random;
  (yield* Sparks).each((spark) => {
    spark.x += random.next() - 0.5; // from 0 inclusive to 1 exclusive
  });
  const roll = random.int(1, 6); // an integer, both ends inclusive
  const cue = random.pick(["thud", "clang"]);
  const deck = random.shuffle([1, 2, 3, 4]); // in place
});

const program = Effect.gen(function* () {
  const app = yield* App.make({ systems: [Scatter], seed: 2024 });
});
```

- Its methods are plain calls, so they are fine inside a loop. A draw costs about 4 ns.
- The same seed produces the same numbers on every machine and in every JavaScript engine. Without a seed, the seed is 0, so a game stays reproducible until you pass a seed from outside, such as the current time at the entry point.
- `int` gives every value equal probability, and `shuffle` every permutation.
- The generator's state is four numbers in the world, `app.world.random.state`, so it is part of the world's hash. A replay with the same seed draws the same numbers, and copying the state back resumes the sequence where it was.
- Inside an app, Effect's own `Random` module is seeded from the same generator, so `Random.next` from `"effect"`, and anything built on it, replays too. It costs an Effect per draw, so don't use it in loops.
- In the frame and input stages, `Random` is a separate generator that isn't part of the world, so rendering can be random without changing the game.
- It isn't suitable for secrets: a few outputs reveal the rest.

## Read more

- [`System`](/reference/arcadekit/System) and [`State`](/reference/arcadekit/State) in the API reference, with [`Random`](/reference/arcadekit/Services#random) and [`Ticks`](/reference/arcadekit/Services#ticks).
