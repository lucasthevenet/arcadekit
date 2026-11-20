---
title: "Scripts"
description: "A script is an Effect that runs across many ticks: sequential code that waits for game time to pass or for an event. Use it for cutscenes, enemy waves and tutorial steps."
---

A **script** is an Effect that runs across many ticks: ordinary sequential code that waits for game time to pass or for something to happen. Use scripts for cutscenes, waves of enemies, or tutorial steps.

## Writing a script

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

A script can wait in three ways:

- `script.nextTick` waits until the next tick;
- `script.sleep(seconds)` waits for game time, which only advances as the game ticks;
- `yield* event.wait` waits until an event arrives.

A script only advances during ticks. It never waits on the system clock: `Effect.sleep`, a promise or a timer would resume it outside a tick, at a moment no replay can reproduce. Nothing refuses them, so avoid them in scripts.

In a game that [ticks only when needed](running-a-game.md), a script that sleeps or waits for a tick keeps the game ticking. A script that should let the game rest waits for an event instead.

## Starting a script

- `app.spawnScript(Fountain)` starts it from outside the simulation: it runs immediately, up to its first wait.
- `(yield* Script).spawn(Fountain)` starts it from a system, a handler or another script: it first runs when the tick flushes, after the systems.
- A plugin's `scripts` start with the app, after its `setup`.

## Failures

The app supervises every script started these ways. A script that fails is logged immediately, with its cause, through Effect's logger, so loggers provided to `App.make` receive it. An interrupted script hasn't failed, and every running script is interrupted when the app's scope closes.

By default, the game continues without the failed script. With `App.make({ onScriptFailure: "stop" })` the app stops instead: the tick the script failed in runs to its end and then fails with `App.ScriptFailed`, a defect carrying the script's cause, as does every later tick, without running anything. A driver stops on it.

A fiber started with `Effect.forkDetach` is the caller's to observe. The app doesn't report its failure or interrupt it, and nothing stops it changing the game at a moment no replay can reproduce.

## Scripts and saves

A save can't hold where a script is. A plugin's `scripts` restart from the beginning when a game is loaded, so a script keeps anything it must not lose in the world, and resumes from what it finds there.

A script started with `app.spawnScript` or `Script.spawn` would not run after a load, so `app.save()` fails with `Save.SaveRefused` while one is running. Save once it has ended.

A moment can't hold a script either, so `app.capture()` fails while any script is running. A rollback session rewinds to such moments, so it refuses a game with scripts: `Rollback.make` throws when one is running, a plugin's included, and starting one throws once the session has the app. A game played with rollback does with systems and states what a script would do.

## Read more

- [`Script`](/reference/arcadekit/Services#script) in the API reference.
