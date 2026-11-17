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
| `handlers` | Its action handlers |
| `components` | Its components, singletons and states, so a save that names them can be loaded |
| `layer` | Services for the whole app, built once. What it acquires is let go when the app's scope closes |
| `setup` | An Effect that runs on a fresh start, not on a load |
| `scripts` | Scripts started with the app, and again after a load |

Events and actions are plain values, so a plugin doesn't list them. It exports them from its module.

## Services from outside

Whatever the systems, handlers and setups need that no plugin provides stays a requirement of `App.make`. It is provided the usual Effect way, and a missing one is the usual compile error:

```ts sketch
App.make({ plugins: [Sfx] }).pipe(Effect.provide(AudioLive));
```

A plugin's layer can use what its dependencies provide. A layer or setup that fails makes `App.make` fail with that error.

## Configuration

A `Resource` is a value with a default that a layer can override. Nothing has to provide it:

```ts
import { Resource } from "arcadekit";

const Gravity = Resource.make("physics/Gravity", { defaultValue: () => -9.81 });
const OnTheMoon = Resource.layer(Gravity, -1.62);
```

A system reads it with `yield* Gravity`. It is configuration, not game state, and isn't saved.

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

- A plugin's `index.ts` exports `plugin`, and the components, queries, systems, events and actions that other plugins build on. Another plugin imports it by that file and lists `Physics.plugin` in its `plugins`.
- A plugin's raw loops, the bodies of its `eachChunk` calls, can go in a `loops.ts` of their own: plain functions of a range of rows, columns and numbers, which import nothing and close over nothing. The system stays in `index.ts` and passes in what the loop needs. A loop that draws random numbers, uses `Commands` or emits an event stays in its system.
- What draws, what plays and the UI are plugins of their own, which the rules never import. So a server or a replay runs the rules alone.

[`examples/demo`](../../../../../packages/arcadekit/examples/demo) is laid out this way.

## Read more

- [Plugins](/reference/arcadekit#plugins) in the reference.
