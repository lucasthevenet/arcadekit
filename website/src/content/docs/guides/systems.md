---
title: "Systems"
description: "A system is the game's code: one Effect per tick, with plain loops inside. This guide covers the order systems run in, their stages, running only some of the time, and saying what a system touches."
---

A system is the game's code: one Effect per tick, with plain loops inside. This guide covers the order systems run in, their stages, running only some of the time, and saying what a system touches.

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

## Order

Systems run in the order they are listed. A plugin's systems come before the app's own, and a plugin's dependencies' before it.

`System.after(other)` and `System.before(other)` move a system to just after or before another:

```ts sketch
const Expiry = System.make("game/Expiry", function* () {
  /* … */
}).pipe(System.after(Movement));
```

These order systems within a stage. Saying an order that is already true changes nothing, so say it wherever it matters.

## Stages

A tick has three stages, `"preUpdate"`, `"update"` and `"postUpdate"`, each run whole before the next. A frame has three too, `"preFrame"`, `"frame"` and `"postFrame"`. And there is the input stage, before each tick. A system is in `"update"` unless it says otherwise:

```ts sketch
const Draw = System.make("game/Draw", function* () {
  /* … */
}).pipe(System.inStage("frame"));
```

`app.systemOrder` and `app.frameOrder` list the systems in the order they run. See [ticks and frames](../concepts/ticks-and-frames.md) for what each stage may do.

## Running only some of the time

`System.runIf(condition)` runs a system only on the ticks when the condition holds. A condition is any Effect that gives a boolean. The usual one is a state:

```ts sketch
const Movement = System.make("game/Movement", function* () {
  /* … */
}).pipe(System.runIf(State.is(Phase, "playing")));
```

A system that keeps something outside itself as it should be, music or a picture, can say what to do while it doesn't run with `System.otherwise(effect)`. See [states](states.md).

## Saying what a system touches

A system can say what it reads and writes, with `System.access`. Most of it is its queries, which already say which terms they only read. Beside them it names what it touches some other way:

```ts
import {
  Component,
  Event,
  Field,
  Query,
  Singleton,
  System,
  Time,
} from "arcadekit";

const Position = Component.define("game/Position", { x: Field.f32 });
const Velocity = Component.define("game/Velocity", { x: Field.f32 });
const Score = Singleton.define(
  "game/Score",
  { points: Field.i32 },
  { points: 0 }
);
const Hit = Event.define<{ readonly damage: number }>("game/Hit");

const Moving = Query.all(Position, Velocity).pipe(Query.reads(Velocity));

const Movement = System.make("game/Movement", function* () {
  const { delta } = yield* Time;
  (yield* Moving).each((position, velocity) => {
    position.x += velocity.x * delta;
  });
}).pipe(System.access({ queries: [Moving] }));

const Scoring = System.make("game/Scoring", function* () {
  const score = yield* Score;
  for (const hit of (yield* Hit).read()) {
    score.points += hit.damage;
  }
}).pipe(System.access({ reads: [Hit], writes: [Score] }));
```

| It says | For |
| --- | --- |
| `queries` | The queries it visits |
| `reads` | What it reads and doesn't change: a singleton, a state, an event it reads |
| `writes` | What it changes: a singleton, a state, an event it emits, a component it spawns, adds, removes or sets through `World` |
| `random: true` | It draws from `Random` |
| `actions: true` | It issues actions |
| `scripts: true` | It starts scripts |

What a system says is held: if it touches something it left out, that throws where it happens and names what to add. So what it says can be relied on.

Then the app can check the order. `app.conflicts` lists the pairs of systems that touch the same thing, one of them to write it, in an order nothing says: which runs first is an accident of where they were listed. `app.undeclared` lists the systems that haven't said. A test can hold both to empty:

```ts sketch
expect(app.conflicts).toEqual([]);
expect(app.undeclared).toEqual([]);
```

A conflict is settled by saying the order, with `System.after` or `System.before`.

## Read more

- [`System`](/reference/arcadekit/System) and [`State`](/reference/arcadekit/State) in the API reference.
