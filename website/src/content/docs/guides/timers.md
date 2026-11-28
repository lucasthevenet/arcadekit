---
title: "Timers"
description: "A timer is the seconds left before something happens, kept in the world: a cooldown, a lifetime, and a system that runs every so often."
---

A **timer** is the seconds left before something happens, kept in the world. A system runs to the end of its tick and waits for nothing, so whatever has to wait is a number that goes down by the tick's `delta`. `Timer` gives the three kinds a game needs: a cooldown its own code counts down, a lifetime after which an entity is despawned, and a system that runs every so often.

A timer is game state like any other. A save holds it, the world's hash covers it, and a rewind and a replay count it down the same way, so a replay fires on the same ticks as the game it records.

## Wait between two shots

```ts
import {
  Action,
  Commands,
  Component,
  Field,
  Plugin,
  Query,
  Singleton,
  System,
  Time,
  Timer,
} from "arcadekit";
import { Schema } from "effect";

const Gun = Component.define("game/Gun", { cooldown: Timer.field });
const Bullet = Component.define("game/Bullet", { dx: Field.f32 });
const Trigger = Singleton.define(
  "game/Trigger",
  { held: Field.u8 },
  { held: 0 }
);

const Guns = Query.all(Gun).pipe(Query.writes(Gun));

const Fire = System.tick("game/Fire", function* () {
  const { delta } = yield* Time;
  const trigger = yield* Singleton.Read(Trigger);
  const commands = yield* Commands.spawns(Bullet);
  (yield* Query.View(Guns)).each((gun) => {
    gun.cooldown = Timer.tick(gun.cooldown, delta);
    if (trigger.held === 1 && Timer.ready(gun.cooldown)) {
      gun.cooldown = 0.2;
      commands.spawn(Bullet.of({ dx: 8 }));
    }
  });
});

const Hold = Action.define(
  "game/Hold",
  Schema.Struct({ held: Schema.Boolean })
);
const hold = Action.handler(Hold, function* ({ held }) {
  (yield* Singleton.Write(Trigger)).held = held ? 1 : 0;
});

export const Rules = Plugin.make("game/Rules", {
  systems: [Fire],
  handlers: [hold],
});
```

`Timer.field` is a field that holds the seconds a timer has left. Added without a value, it is 0, and ready. The gun's own system counts it down with `Timer.tick`, and starts it again by writing the seconds to wait.

- `Timer.tick(left, delta)` returns what is left after `delta`, and never less than 0. It is a plain function that allocates nothing, so it belongs inside a loop over a query's rows.
- `Timer.ready(left)` is true once the timer has run out.
- A timer goes down only where the game writes `Timer.tick` back to it. A system that doesn't run, because of a [condition](systems.md#run-a-system-only-when-a-condition-holds), leaves its timers where they were, which is how a cooldown waits out a pause.

A timer that has run out stays at 0, so writing it again changes nothing. That matters to a game that ticks only when needed: a running timer changes the world on every tick and keeps the game ticking, and one that has run out lets it rest. A system that compared `Time.elapsed` with a moment it kept would write nothing while it waited, and a resting game would never reach that moment.

## Despawn an entity after a while

```ts
import { Commands, Component, Field, Plugin, System, Timer } from "arcadekit";

const Spark = Component.define("game/Spark", { x: Field.f32, y: Field.f32 });

const Burst = System.tick("game/Burst", function* () {
  const commands = yield* Commands.spawns(Spark, Timer.Lifetime);
  for (let i = 0; i < 8; i++) {
    commands.spawn(Spark.of({ x: i, y: 0 }), Timer.lifetime(0.5));
  }
}).pipe(Timer.every(2));

export const Sparks = Plugin.make("game/Sparks", {
  plugins: [Timer.plugin],
  systems: [Burst],
});
```

`Timer.lifetime(seconds)` is a `Timer.Lifetime` component, spawned or added with the entity. `Timer.plugin` counts every one down at the start of each tick, in `"preUpdate"`, and despawns the entity on the tick its time runs out, so the game's systems in `"update"` never see it.

- List `Timer.plugin` among the game's plugins, or one of its plugins does. A game that spawns or adds a lifetime and leaves it out doesn't compile: `App.make` requires `Plugin.Installed<"arcadekit/Timer">`. A plugin that several others list is installed once.
- A component that `requires` a lifetime doesn't carry that requirement. A game that spawns one without `Timer.plugin` compiles, and nothing counts its lifetime down.
- Name `Timer.Lifetime` where the commands are asked for, `Commands.spawns(Spark, Timer.Lifetime)`, as any component a system spawns.
- A lifetime is counted from the tick after the one it was spawned in.

## Run a system every so often

```ts
import { Commands, Component, Field, Random, System, Timer } from "arcadekit";

const Enemy = Component.define("game/Enemy", { x: Field.f32 });

export const Wave = System.tick("game/Wave", function* () {
  const random = yield* Random;
  (yield* Commands.spawns(Enemy)).spawn(Enemy.of({ x: random.range(0, 10) }));
}).pipe(Timer.every(3));
```

`Timer.every(seconds)` runs a system of the tick once every `seconds` of game time, the first time when `seconds` have gone by. The seconds left to the next run are a singleton of the world, named after the system: `"arcadekit/Timer.every(game/Wave)"`.

- A run that lands part of a tick late makes the next one that much sooner, so the runs keep to their beat. A tick longer than the period runs the system once.
- It is a condition, as `System.runIf` gives one, and counts only on the ticks it is checked. Given after `System.runIf(State.is(Phase, "playing"))`, it waits while the game isn't playing. Given before it, it counts on, and a run that falls due while the game isn't playing is skipped.
- A system of the frame or of the input stage doesn't compile with it: only a tick moves game time on. A period that isn't a positive number throws.
- Renaming the system renames its singleton, so a save taken before the rename starts the count again.

For a timer that repeats on each of many entities, such as an enemy that shoots every two seconds, give the entity a `Timer.field` and write the period back to it when it fires, as the gun above does.
