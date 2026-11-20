---
title: "Plugins"
description: "A plugin bundles a feature into one value: its systems, action handlers, services and startup logic. A game is a plugin made of plugins."
---

A **plugin** bundles a feature into one value: its systems, its action handlers, the services it provides, and its startup logic. A game is a plugin made of plugins.

## Creating a plugin

```ts
import {
  App,
  Commands,
  Component,
  Field,
  Plugin,
  Query,
  System,
  Time,
} from "arcadekit";
import { Context, Effect, Layer } from "effect";

const Position = Component.define("physics/Position", { x: Field.f32 });
const Velocity = Component.define("physics/Velocity", { x: Field.f32 });

class Bounds extends Context.Service<Bounds, { readonly width: number }>()(
  "physics/Bounds"
) {}

const Moving = Query.all(Position, Velocity).pipe(Query.writes(Position));

const Movement = System.make("physics/Movement", function* () {
  const { width } = yield* Bounds;
  const { delta } = yield* Time;
  (yield* Moving).each((position, velocity) => {
    position.x = Math.min(width, position.x + velocity.x * delta);
  });
});

export const Physics = Plugin.make("physics/Physics", {
  // so saves containing them load
  systems: [Movement],
  layer: Layer.succeed(Bounds, { width: 10 }), // services for the whole app
  setup: Effect.gen(function* () {
    // runs once, on a fresh start
    (yield* Commands).spawn(Position.of({ x: 0 }), Velocity.of({ x: 1 }));
  }),
});

const Game = Plugin.make("game/Game", {
  plugins: [Physics], // installed first
});

const program = Effect.gen(function* () {
  const app = yield* App.make({ plugins: [Game] });
  app.tick(1 / 60);
});
```

| Option | Description |
| --- | --- |
| `plugins` | The plugins this one depends on. Each is installed once, however many plugins depend on it |
| `systems` | Its systems, registered after its dependencies' |
| `handlers` | Its action handlers, from which `app.dispatch` is typed |
| `layer` | Services for the whole app, built once. Resources it acquires are released when the app's scope closes |
| `setup` | An Effect that runs on a fresh start, but not on a load, since the save already holds what it spawned |
| `scripts` | Scripts started with the app, after `setup`, and again after a load |

Components, events and actions are plain values, exported from the plugin's module. A plugin doesn't list them: a save finds each by its name, see [saving and loading](/guides/saving-and-loading/#requirements-for-saving).

## Services

A service is how your game's code reaches the outside world: sound, storage, the network. A system asks for the service and never imports the module that does the work, so a test can swap it.

A plugin's `layer` builds its services. While building, it can use the built-in services and whatever the plugin's dependencies provide: a layer that needs another plugin's service lists that plugin in `plugins`. Acquire resources that need releasing with `Effect.acquireRelease` inside `Layer.effect`; they are released when the app's scope closes.

Anything your systems, handlers and setups need that no plugin provides remains a requirement of `App.make`. Provide it the usual Effect way, and a missing one is the usual compile error:

```ts sketch
App.make({ plugins: [Sfx] }).pipe(Effect.provide(AudioLive));
```

If a layer or setup fails, `App.make` fails with that error.

## Configuration

A `Resource` is a value with a default that a layer can override. Nothing has to provide it:

```ts
import { Resource } from "arcadekit";

const Gravity = Resource.make("physics/Gravity", { defaultValue: () => -9.81 });
const OnTheMoon = Resource.layer(Gravity, -1.62);
```

A system reads it with `yield* Gravity`. It is configuration, not game state, and isn't saved. Game state that exists once belongs in a [singleton](components.md#singletons), which lives in the world and is therefore saved, hashed, and restored when an action is refused.

A resource's default is created once and shared by every app in the process, so never mutate it.

## Project layout

Give each plugin its own folder, and make the app in a file at the root:

```
game/
  main.ts           your game's own plugin, and App.run
  physics/
    index.ts        the plugin, and what other plugins use from it
    loops.ts        its raw loops: plain functions with no imports
  look/
    index.ts        rendering, which the rules never import
```

- A plugin's `index.ts` exports `plugin`, and the components, queries, systems, events and actions other plugins build on. Other plugins import only that file, `import * as Physics from "../physics/index"`, and list `Physics.plugin` in their `plugins`.
- A plugin's raw loops, the bodies of its `eachChunk` calls, go in their own `loops.ts`: plain functions of a range of rows, columns and numbers, with no imports and no closures, so they can be tested and run on their own. Such a loop doesn't read fields that hold objects, and uses sparse components only as filters, not as data. A plugin without such loops has no `loops.ts`.
- Rendering, sound and UI are plugins of their own, which the rules never import, so a server or a replay runs the rules alone.

The system itself stays in `index.ts`. It reads what the loop needs, such as the time, a resource or a singleton, and passes it in:

```ts title="physics/loops.ts"
export const fall = (
  start: number,
  end: number,
  py: Float32Array,
  vy: ArrayLike<number>, // a column the query only reads
  delta: number
): void => {
  for (let i = start; i < end; i++) {
    py[i]! += vy[i]! * delta;
  }
};
```

```ts title="physics/index.ts"
import { Component, Field, Plugin, Query, System, Time } from "arcadekit";

import { fall } from "./loops";

export const Position = Component.define("physics/Position", { y: Field.f32 });
export const Velocity = Component.define("physics/Velocity", { y: Field.f32 });
export const Falling = Query.all(Position, Velocity).pipe(
  Query.writes(Position)
);

export const Fall = System.make("physics/Fall", function* () {
  const { delta } = yield* Time;
  (yield* Falling).eachChunk((start, end, position, velocity) =>
    fall(start, end, position.y, velocity.y, delta)
  );
});

export const plugin = Plugin.make("physics/Physics", {
  systems: [Fall],
});
```

A loop that draws from `Random`, spawns or despawns through `Commands`, emits an event, or reads a `json` or `transient` field doesn't belong in `loops.ts`: it stays in its system.

[`examples/demo`](../../../../../packages/arcadekit/examples/demo) follows this layout.

## Read more

- [`Plugin`](/reference/arcadekit/Plugin) and [`Resource`](/reference/arcadekit/Resource) in the API reference.
