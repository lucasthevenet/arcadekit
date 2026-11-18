---
title: "Assets"
description: "Pictures, sounds and data files are loaded as a scoped resource: what was loaded is let go when the scope it was loaded in closes."
---

Pictures, sounds and data files are loaded as a scoped resource: what was loaded is let go when the scope it was loaded in closes. A bundle is the assets that are loaded and let go together, usually a level's.

## A level's bundle

```ts
import { Assets, Plugin, State, System } from "arcadekit";
import * as Browser from "arcadekit/Browser";
import { Schema } from "effect";

const Layout = Schema.Struct({ walls: Schema.Array(Schema.Int) });
const Level = State.define("game/Level", ["menu", "forest"]);

const Forest = Assets.bundle("game/Forest", {
  backdrop: Browser.image("/forest.png"),
  layout: Assets.json("/forest.json", Layout), // checked against the schema
});

const Draw = System.make("game/Draw", function* () {
  const forest = yield* Forest; // what the app holds of it now
  if (forest._tag === "Ready") {
    const picture: ImageBitmap = forest.assets.backdrop;
  }
}).pipe(System.inStage("frame"));

const Game = Plugin.make("game/Game", {
  plugins: [Assets.plugin],
  components: [Level],
  systems: [Assets.during(State.is(Level, "forest"), Forest), Draw],
});
```

`Assets.during(condition, bundle)` gives a level its scope. It is a system that keeps a bundle loaded while the condition holds, one of `System.runIf`'s, usually a state. From the frame after the game enters the level, the bundle is loading, in a scope of its own. From the frame after it leaves, that scope is closed: a picture is closed, and a file still on its way is given up. Entered again, the level loads again.

- It is one system per bundle. To keep a bundle for several states, give a condition that holds in each.
- It runs in `"preFrame"`, the stage before a frame's own, so every system of a frame finds the bundle as it then is, wherever the two are listed.
- Whatever is still loaded when the app's scope closes goes with it.

`yield*` on the bundle gives what the app holds of it: `Absent`, `Loading`, `Ready` with the `assets`, each under its name and with its type, or `Failed` with the error. A bundle that failed is logged once, keeps nothing of what did load, and is tried again the next time its level is entered.

## Loading is not part of the simulation

Loading takes real time, so a bundle can be asked for in the frame stage and the input stage only. In a tick it throws. A replay or a server, which draw nothing, load nothing, and the game they run is the same game.

A load is given what the app was given from outside and none of the app's own services, so nothing it does is the game's doing: the random numbers a loader draws, to wait a while before it tries again, are not the world's.

What the rules need from a file, such as where the walls are, reaches them as an action. A system of the input stage issues it once the file is there, with what it read as the payload. From then on it is in the log, and a replay has it without the file:

```ts sketch
const Begin = System.make("game/Begin", function* () {
  const forest = yield* Forest;
  if (forest._tag === "Ready" && (yield* Walls).count() === 0) {
    (yield* Action.Actions).enqueue(Build, forest.assets.layout);
  }
}).pipe(System.inStage("input"));
```

## Kinds of asset

| Asset | Gives |
| --- | --- |
| `Assets.bytes(url)` | A `Uint8Array`, the file as it is |
| `Assets.text(url)` | A string, of a file that is UTF-8 |
| `Assets.json(url, schema)` | A value checked against the schema |
| `Browser.image(url)` | An `ImageBitmap`, closed when let go |
| `Browser.sound(url)` | A `Sound.Clip`, decoded whole. See [sound](sound.md) |
| `Assets.make(url, decode)` | Anything else, with `Effect.acquireRelease` for what has to be let go |

[`@arcadekit/three`](/reference/three) adds `Three.texture(url)` and `Gltf.model(url)`.

## Loading for as long as the app

Anywhere there is a scope, `Assets.load(bundle)` loads into it and waits: every asset at once, failing with `Assets.AssetFailed`, which names the URL, at the first that does. That is for the entry point, or a plugin's `layer`, which holds what it loads for as long as the app:

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

What has to be let go is loaded in a scope. Nothing is loaded into a module-level variable, which no scope closes.

`Assets.load` waits in real time, so it is not for a system or a script, and nothing refuses it there. A script that loads resumes in whatever tick the file happens to arrive in, and a replay of it fetches the file again.

## Holding a bundle yourself

A system of the game's own, in the frame stage or the input stage, can keep a bundle too, with `(yield* Assets.Store).hold(bundle, name)` and `drop(bundle, name)`: the bundle stays loaded while anyone holds it. In the tick the store throws, whatever it is asked, as a bundle does.

## Where the bytes come from

They come through `Assets.Loader`, which is `fetch` unless told otherwise, given up when the load is interrupted. A test provides its files in memory with `Assets.layerMemory({ "/forest.json": "..." })`.

## Not done yet

- An asset is a picture, a sound, text, JSON or bytes. A font is for whoever draws with it to decode, with `Assets.make`.
- A bundle is loaded or it is not: it does not say how far along it is, and a file that two bundles name is fetched for each.
- A bundle that failed stays failed until its level is entered again. Nothing tries again by itself.

## Read more

- [`Assets`](/reference/arcadekit/Assets) in the API reference.
