---
title: "Assets"
description: "Images, sounds and data files load as a scoped resource, released when the scope they were loaded in closes. A bundle groups the assets of one level."
---

Images, sounds and data files load as a **scoped resource**: everything loaded is released when the scope it was loaded in closes. A **bundle** groups the assets that load and release together, usually a level's.

## A level's bundle

```ts
import { Assets, Plugin, State, System } from "arcadekit";
import * as Browser from "arcadekit/Browser";
import { Schema } from "effect";

const Layout = Schema.Struct({ walls: Schema.Array(Schema.Int) });
const Level = State.define("game/Level", ["menu", "forest"]);

const Forest = Assets.bundle("game/Forest", {
  backdrop: Browser.image("/forest.png"),
  layout: Assets.json("/forest.json", Layout), // validated against the schema
});

const Draw = System.make("game/Draw", function* () {
  const forest = yield* Forest; // the bundle's current status
  if (forest._tag === "Ready") {
    const picture: ImageBitmap = forest.assets.backdrop;
  }
}).pipe(System.inStage("frame"));

const Game = Plugin.make("game/Game", {
  plugins: [Assets.plugin],
  systems: [Assets.during(State.is(Level, "forest"), Forest), Draw],
});
```

`Assets.during(condition, bundle)` gives a level its scope. It creates a system that keeps a bundle loaded while the condition holds, using a `System.runIf` condition, usually a state. From the frame after the game enters the level, the bundle loads in a scope of its own. From the frame after it leaves, that scope closes: images are closed, and files still downloading are cancelled. Entering the level again loads the bundle again.

- There is one system per bundle. To keep a bundle loaded across several states, give a condition that holds in each.
- It runs in `"preFrame"`, the stage before the frame's own, so every frame system sees the bundle in the same status, wherever the two are listed.
- Anything still loaded when the app's scope closes is released with it.

`yield*` on a bundle gives its current status: `Absent`, `Loading`, `Ready` with the `assets`, each under its name and with its type, or `Failed` with the error. A failed bundle is logged once, keeps nothing of what did load, and is retried the next time its level is entered.

## Loading happens outside the simulation

Loading takes real time, so a bundle can only be requested from the frame and input stages; in a tick it throws. A replay or a server, which draws nothing, loads nothing, and runs the same game.

A load receives what the app was given from outside, but none of the app's own services, so nothing it does counts as part of the game: the random numbers a loader draws to back off before retrying aren't the world's.

When the rules need something from a file, such as where the walls are, it reaches them as an action. An input-stage system issues the action once the file has loaded, with its contents as the payload. From then on it is in the log, and a replay has it without the file:

```ts sketch
const Begin = System.make("game/Begin", function* () {
  const forest = yield* Forest;
  if (forest._tag === "Ready" && (yield* Walls).count() === 0) {
    (yield* Action.Actions).enqueue(Build, forest.assets.layout);
  }
}).pipe(System.inStage("input"));
```

## Asset types

| Asset | Produces |
| --- | --- |
| `Assets.bytes(url)` | A `Uint8Array` of the raw file |
| `Assets.text(url)` | A string, from a UTF-8 file |
| `Assets.json(url, schema)` | A value validated against the schema |
| `Browser.image(url)` | An `ImageBitmap`, closed on release |
| `Browser.sound(url)` | A `Sound.Clip`, fully decoded. See [sound](sound.md) |
| `Assets.make(url, decode)` | Anything else, with `Effect.acquireRelease` for what needs releasing, such as a font |

[`@arcadekit/three`](/reference/three) adds `Three.texture(url)` and `Gltf.model(url)`.

## Loading for the app's lifetime

Anywhere you have a scope, `Assets.load(bundle)` loads a bundle into it and waits: all assets in parallel, failing with `Assets.AssetFailed`, which names the URL, at the first failure. Use it at the entry point, or in a plugin's `layer`, which keeps what it loads for the app's lifetime:

```ts
import { Assets, Plugin } from "arcadekit";
import { Context, Layer, Schema } from "effect";

const Common = Assets.bundle("game/Common", {
  names: Assets.json("/names.json", Schema.Array(Schema.String)),
});

class Names extends Context.Service<
  Names,
  Assets.Loaded<typeof Common.assets>
>()("game/Names") {}

const Game = Plugin.make("game/Game", {
  layer: Layer.effect(Names, Assets.load(Common)),
});
```

Load anything that needs releasing into a scope, never into a module-level variable, which no scope closes.

`Assets.load` waits in real time, so it isn't for systems: a system that waits throws, and the error names it. The rules get what is in a file as an action, as [above](#loading-happens-outside-the-simulation).

## Holding a bundle yourself

A frame or input-stage system of your own can keep a bundle loaded with `(yield* Assets.Store).hold(bundle, name)` and `drop(bundle, name)`: the bundle stays loaded while anyone holds it. In a tick, the store throws whatever you ask of it, as a bundle does.

## Where files come from

Files are fetched through `Assets.Loader`, which uses `fetch` by default and cancels the request when the load is interrupted. In a page, `Browser.runMain` and `Browser.layer` read a path against the document's base, as `fetch` does, so a page with a `<base href>` loads from there. A test serves its files from memory with `Assets.layerMemory({ "/forest.json": "..." })`.

## Read more

- [`Assets`](/reference/arcadekit/Assets) in the API reference.
