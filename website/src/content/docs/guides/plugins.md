---
title: "Plugins"
description: "A plugin is one value that bundles a feature: its systems, its action handlers, its components, the services it provides, and what it does at the start. A game is a plugin of plugins."
---

A plugin is one value that bundles a feature: its systems, its action handlers, its components, the services it provides, and what it does at the start. A game is a plugin of plugins.

## Making one

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

const Moving = Query.all(Position, Velocity).pipe(Query.reads(Velocity));

const Movement = System.make("physics/Movement", function* () {
  const { width } = yield* Bounds;
  const { delta } = yield* Time;
  (yield* Moving).each((position, velocity) => {
    position.x = Math.min(width, position.x + velocity.x * delta);
  });
});

export const Physics = Plugin.make("physics/Physics", {
  components: [Position, Velocity], // so a save that names them loads
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

| Option | What it is |
| --- | --- |
| `plugins` | The plugins this one depends on. Each is installed once, however many depend on it |
| `systems` | Its systems, registered after its dependencies' |
| `handlers` | Its action handlers, which `app.dispatch` is typed from |
| `components` | Its components, singletons and states, so a save that names them can be loaded |
| `layer` | Services for the whole app, built once. What it acquires is let go when the app's scope closes |
| `setup` | An Effect that runs on a fresh start, not on a load, which has what it spawned |
| `scripts` | Scripts started with the app, after `setup`, and again after a load |

Events and actions are plain values, so a plugin doesn't list them. It exports them from its module.

## Services

A service is how a game's code reaches what is outside it: sound, storage, the network. A system asks for the service and never imports the module that does the work, so a test can swap it.

A plugin's `layer` is where its services are built. While it builds, it can use the built-in services and what the plugin's dependencies provide: a layer that needs another plugin's service lists that plugin in `plugins`. What has to be let go is acquired with `Effect.acquireRelease` inside `Layer.effect`, and released when the app's scope closes.

Whatever the systems, handlers and setups need that no plugin provides stays a requirement of `App.make`. It is provided the usual Effect way, and a missing one is the usual compile error:

```ts sketch
App.make({ plugins: [Sfx] }).pipe(Effect.provide(AudioLive));
```

A layer or setup that fails makes `App.make` fail with that error.

## Configuration

A `Resource` is a value with a default that a layer can override. Nothing has to provide it:

```ts
import { Resource } from "arcadekit";

const Gravity = Resource.make("physics/Gravity", { defaultValue: () => -9.81 });
const OnTheMoon = Resource.layer(Gravity, -1.62);
```

A system reads it with `yield* Gravity`. It is configuration, not game state, and isn't saved. Game state of which there is one is a [singleton](components.md#singletons): it is in the world, so it is saved, hashed, and put back when an action is refused.

A resource's default is made once and shared by every app in the process, so nothing changes it in place.

## How a game is laid out

A folder for each plugin, and a file at the root that makes the app:

```
game/
  main.ts           the game's own plugin, and App.run
  physics/
    index.ts        the plugin, and what other plugins use of it
    loops.ts        its raw loops: plain functions, importing nothing
  look/
    index.ts        what draws, which the rules never import
```

- A plugin's `index.ts` exports `plugin`, and the components, queries, systems, events and actions that other plugins build on. Another plugin imports that file and nothing else of the folder, `import * as Physics from "../physics/index"`, and lists `Physics.plugin` in its `plugins`.
- A plugin's raw loops, the bodies of its `eachChunk` calls, go in a `loops.ts` of their own: plain functions of a range of rows, columns and numbers, which import nothing and close over nothing, so whatever runs one needs only to have imported it. A plugin with no such loop has no `loops.ts`.
- What draws, what plays and the UI are plugins of their own, which the rules never import. So a server or a replay runs the rules alone.

The system stays in `index.ts`. It reads what the loop needs, the time, a resource or a singleton, and passes it in:

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
  Query.reads(Velocity)
);

export const Fall = System.make("physics/Fall", function* () {
  const { delta } = yield* Time;
  (yield* Falling).eachChunk((start, end, position, velocity) =>
    fall(start, end, position.y, velocity.y, delta)
  );
}).pipe(System.access({ queries: [Falling] }));

export const plugin = Plugin.make("physics/Physics", {
  components: [Position, Velocity],
  systems: [Fall],
});
```

A loop that draws from `Random`, spawns or despawns through `Commands`, emits an event, or reads a `json` or `transient` field is not one of these: it stays in its system.

[`examples/demo`](../../../../../packages/arcadekit/examples/demo) is laid out this way.

## Not done yet

Nothing runs on a worker yet. Loops kept in a `loops.ts` are what running systems on workers will need: a worker has no closure of the main thread's, so what runs on one is a loop it imported itself. How a worker will come to import a game's loops, and so which files a game adds for it, is not decided.

## Read more

- [`Plugin`](/reference/arcadekit/Plugin) and [`Resource`](/reference/arcadekit/Resource) in the API reference.
