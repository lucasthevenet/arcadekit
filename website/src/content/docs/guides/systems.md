---
title: "Systems"
description: "A system is the game's code: one Effect per tick, with plain loops inside. This guide covers the order systems run in, their stages, running only some of the time, random numbers, and saying what a system touches."
---

A system is the game's code: one Effect per tick, with plain loops inside. This guide covers the order systems run in, their stages, running only some of the time, random numbers, and saying what a system touches.

## Making one

```ts
import { Component, Field, Query, System, Time } from "arcadekit";

const Position = Component.define("game/Position", { x: Field.f32 });
const Velocity = Component.define("game/Velocity", { x: Field.f32 });
const Moving = Query.all(Position, Velocity).pipe(Query.reads(Velocity));

const Movement = System.make("game/Movement", function* () {
  const { delta } = yield* Time;
  (yield* Moving).each((position, velocity) => {
    position.x += velocity.x * delta;
  });
});
```

The body asks for what it needs with `yield*`: queries, singletons, events, `Time`, `Random`, `Commands`, `World`, and any service of the game's own. Whatever it needs that no plugin provides is a requirement of the app, and a missing one doesn't compile.

A system finishes within its tick: one that waits throws, and the error names it. Work that takes many ticks is a [script](scripts.md). A system changes which entities exist only through `Commands`, and reacts to what changed with a [change query](queries.md), not by comparing with a copy it keeps. It issues an action with the [`Actions` service](events-and-actions.md), never with `app.enqueue`, which would put the action in the log and have a replay apply it twice.

## Order

Systems run in the order they are listed. A plugin's systems come before the app's own, and a plugin's dependencies' before it.

`System.after(other)` and `System.before(other)` say that a system runs after or before another:

```ts sketch
const Expiry = System.make("game/Expiry", function* () {
  /* … */
}).pipe(System.after(Movement));
```

These order systems within a stage. Saying an order that is already true changes nothing, so say it wherever it matters.

Each system keeps its place in the list unless another has to run before it, and that one is then pulled forward to just ahead of it. The system that moved now runs ahead of everything listed between the two, which said nothing: it may now run before a system it reads from, with no error. [Checking the order](system-access.md#checking-the-order) finds such a pair when both systems have said what they touch.

## Stages

A tick has three stages, `"preUpdate"`, `"update"` and `"postUpdate"`, each run whole before the next. A frame has three too, `"preFrame"`, `"frame"` and `"postFrame"`. And there is the input stage, before each tick. A system is in `"update"` unless it says otherwise:

```ts sketch
const Draw = System.make("game/Draw", function* () {
  /* … */
}).pipe(System.inStage("frame"));
```

`"preFrame"` is for what every system of a frame stands on, such as which assets are loaded, and `"postFrame"` for what needs everything drawn, such as a renderer's last step.

The frame stage and the input stage are outside the simulation, and a replay runs neither. So an action issued there with `Actions.enqueue` is logged, as one from outside is.

`app.systemOrder` and `app.frameOrder` list the systems in the order they run. See [ticks and frames](../concepts/ticks-and-frames.md) for what each stage may do.

## Running only some of the time

`System.runIf(condition)` runs a system only on the ticks when the condition holds. A condition is any Effect that gives a boolean. The usual one is a state:

```ts sketch
const Movement = System.make("game/Movement", function* () {
  /* … */
}).pipe(System.runIf(State.is(Phase, "playing")));
```

A system that keeps something outside itself as it should be, music or a picture, can say what to do while it doesn't run with `System.otherwise(effect)`. See [states](states.md).

## Work of a system's own

A game that [ticks only when needed](running-a-game.md) rests when nothing is waiting, and what the app can see waiting is actions, states, scripts and events. A system that has work every tick for a while, a clock that runs down or a body in flight, is none of those. It asks for the next tick itself, each tick it has more to do:

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

Nothing tells a system that counts down and never asks from one with nothing to do: it stops when the game rests, with no error. In a game that ticks in real time `more` does nothing, so a system that might ever run in a game that rests says it. A handler or a script asks the same way.

## Random numbers

`Random` is the one source of randomness in a simulation:

```ts
import { App, Component, Field, Query, Random, System } from "arcadekit";
import { Effect } from "effect";

const Spark = Component.define("game/Spark", { x: Field.f32 });
const Sparks = Query.all(Spark);

const Scatter = System.make("game/Scatter", function* () {
  const random = yield* Random;
  (yield* Sparks).each((spark) => {
    spark.x += random.next() - 0.5; // from 0 up to, not including, 1
  });
  const roll = random.int(1, 6); // a whole number, both ends included
  const cue = random.pick(["thud", "clang"]);
  const deck = random.shuffle([1, 2, 3, 4]); // in place
});

const program = Effect.gen(function* () {
  const app = yield* App.make({ systems: [Scatter], seed: 2024 });
});
```

- Its methods are plain calls, so they are fine inside a loop. A draw costs about 4 ns.
- The same seed gives the same numbers on every machine and in every JavaScript engine. With no seed, the seed is 0, so a game is repeatable until it is given a seed from outside, such as the time at the entry point.
- `int` gives every value equal odds, and `shuffle` every order.
- The generator's state is four numbers in the world, `app.world.random.state`, so it is in the world's hash. A replay made with the same seed draws the same numbers, and copying the state back resumes the sequence where it was.
- Effect's own `Random` module is seeded from the same generator inside an app, so `Random.next` from `"effect"`, or anything built on it, replays too. It costs an Effect per draw, so it isn't for loops.
- In the frame stage and the input stage, `Random` is a generator of its own, which is no part of the world: what draws can be random and change nothing.
- It isn't for secrets: a few outputs give away the rest.

## Saying what a system touches

A system can say what it reads and writes, with `System.access`: its queries, and beside them what it touches some other way.

```ts sketch
const Movement = System.make("game/Movement", function* () {
  /* … */
}).pipe(System.access({ queries: [Moving] }));
```

The app holds the system to what it said, and can then check the order: `app.conflicts` lists the pairs of systems that touch the same thing, one of them to write it, in an order nothing says. A system of a plugin says what it touches, so that whichever game installs it can check its order. See [what a system reads and writes](system-access.md).

## Read more

- [`System`](/reference/arcadekit/System) and [`State`](/reference/arcadekit/State) in the API reference, with [`Random`](/reference/arcadekit/Services#random) and [`Ticks`](/reference/arcadekit/Services#ticks).
