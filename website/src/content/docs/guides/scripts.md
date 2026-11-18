---
title: "Scripts"
description: "A script is an Effect that runs across many ticks: ordinary sequential code that waits for time to pass or for something to happen. A cutscene, a wave of enemies, a tutorial step."
---

A script is an Effect that runs across many ticks: ordinary sequential code that waits for time to pass or for something to happen. A cutscene, a wave of enemies, a tutorial step.

## Writing one

```ts
import { Commands, Component, Field, Script } from "arcadekit";
import { Effect } from "effect";

const Position = Component.define("game/Position", {
  x: Field.f32,
  y: Field.f32,
});
const Velocity = Component.define("game/Velocity", {
  x: Field.f32,
  y: Field.f32,
});

const Fountain = Effect.gen(function* () {
  const script = yield* Script;
  const commands = yield* Commands;
  for (let wave = 1; wave <= 5; wave++) {
    commands.spawn(Position.of({ x: 0, y: 0 }), Velocity.of({ x: 0, y: wave }));
    yield* script.sleep(0.5); // half a second of game time
  }
});
```

A script waits three ways:

- `script.nextTick`, until the next tick;
- `script.sleep(seconds)`, for game time, which passes only as the game ticks;
- `yield* event.wait`, until an event arrives.

A script advances only during ticks. It never waits on the clock: `Effect.sleep`, a promise or a timer would resume it outside a tick, at a moment no replay repeats. Nothing refuses them.

In a game that [ticks only when needed](running-a-game.md), a script that sleeps or waits for a tick keeps the game ticking. One that should let it rest waits for an event.

## Starting one

- `app.spawnScript(Fountain)` from outside: it runs now, up to its first wait.
- `(yield* Script).spawn(Fountain)` from a system, a handler or another script: it first runs when the tick flushes, after the systems.
- A plugin's `scripts` start with the app, after its `setup`.

## When one fails

The app watches every script started these ways. One that fails is logged at once, with its cause, through Effect's logger, so the loggers provided to `App.make` receive it. One that is interrupted has not failed, and every script still running is interrupted when the app's scope closes.

The game goes on without the failed script. With `App.make({ onScriptFailure: "stop" })` the app stops instead: the tick the script failed in runs to its end and then fails with `App.ScriptFailed`, a defect that carries the script's cause, and so does every tick after it, without running anything. A driver stops on it.

A fiber started with `Effect.forkDetach` is the caller's to observe. The app doesn't report its failure or interrupt it, and nothing stops it changing the game at a moment no replay repeats.

## Scripts and saves

A save can't hold a script in mid-flight. A plugin lists its `scripts`, and they start again from their beginning when a game is loaded. So a script keeps what it must not lose in the world, and picks up from what it finds there. The same goes for a rewind under rollback.

## Read more

- [`Script`](/reference/arcadekit/Services#script) in the API reference.
