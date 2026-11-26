---
title: "Assets"
description: "Images, sounds and data files load as a scoped resource, released when the scope they were loaded in closes. A bundle groups the assets of one level."
---

An **asset** is a file the game loads, such as an image, a sound, or a data file. Assets load as a scoped resource, so everything loaded is released when the scope it was loaded in closes. A **bundle** groups the assets that load and release together, usually a level's.

## Load a level's bundle

```ts
import { Assets, Plugin, State, System } from "arcadekit";
import { Browser } from "arcadekit/browser";
import { Schema } from "effect";

const Layout = Schema.Struct({ walls: Schema.Array(Schema.Int) });
const Level = State.define("game/Level", ["menu", "forest"]);

const Forest = Assets.bundle("game/Forest", {
  backdrop: Browser.image("/forest.png"),
  layout: Assets.json("/forest.json", Layout), // validated against the schema
});

const Draw = System.frame("game/Draw", function* () {
  const forest = yield* Forest; // the bundle's current status
  if (forest._tag === "Ready") {
    const picture: ImageBitmap = forest.assets.backdrop;
  }
});

const Game = Plugin.make("game/Game", {
  plugins: [Assets.plugin],
  systems: [Assets.during(State.is(Level, "forest"), Forest), Draw],
});
```

`Assets.during(condition, bundle)` gives a level its scope. It makes a system that keeps a bundle loaded while the condition holds. The condition is the same as `System.runIf`'s, usually a state. From the frame after the game enters the level, the bundle loads in a scope of its own. From the frame after the game leaves, that scope closes. Images are closed, and downloads still running are cancelled. Entering the level again loads the bundle again.

- Use one `Assets.during` per bundle. To keep a bundle loaded across several states, give a condition that holds in each.
- The system runs in `"preFrame"`, the stage before the frame's own. Every frame system sees the bundle in the same status, whatever order the systems are listed in.
- Anything still loaded when the app is closed is released with it.

`yield*` on a bundle gives its current status: `Absent`, `Loading`, `Ready`, or `Failed`. `Ready` holds the `assets`, each under its name and with its type, and `Failed` holds the error. The store logs a failed bundle once, keeps nothing of what did load, and retries it the next time its level is entered.

## Share files between bundles

Bundles that are held at the same time share what they load. A file named by two of them is fetched once, and kept while either is loaded. An asset that two of them have, the same value in each, is decoded once, and released when the last of them is let go. An asset made twice, such as `Browser.image("/forest.png")` written in two bundles, is decoded once for each, from the one fetch.

A fetch that may succeed if tried again is tried again, up to three times, 200, 400 and 800 milliseconds later. That is a request that got no answer, a download that was cut off, or a server that answered 500 or more. Its bundle stays `Loading` meanwhile, and becomes `Ready` if one of them succeeds, with no need to enter its level again. A missing file, an answer of 404, or a file that doesn't decode fails at once.

## Pass a file's contents to the rules

Loading takes real time, so only the frame and input stages can request a bundle. A system of the tick can't require `Assets.Store`. A replay or a server draws nothing, loads nothing, and runs the same game.

A load receives the services the app was given from outside, but none of the app's own. Nothing it does counts as part of the game. The random numbers that a loader draws to back off before a retry don't come from the world.

When the rules need something from a file, such as where the walls are, pass it to them as an action. An input-stage system issues the action once the file has loaded, with the file's contents as the payload. From then on the contents are in the log, and a replay has them without the file:

```ts sketch
const Begin = System.input("game/Begin", function* () {
  const forest = yield* Forest;
  if (forest._tag === "Ready" && (yield* Walls).count() === 0) {
    (yield* Action.Actions).enqueue(Build, forest.assets.layout);
  }
});
```

## Choose an asset type

| Asset | Produces |
| --- | --- |
| `Assets.bytes(url)` | A `Uint8Array` of the raw file |
| `Assets.text(url)` | A string, from a UTF-8 file |
| `Assets.json(url, schema)` | A value validated against the schema |
| `Browser.image(url)` | An `ImageBitmap`, closed on release |
| `Audio.sound(url)` | A `Sound.Clip`, fully decoded. See [play a level's own sounds](sound-in-a-page.md#play-a-levels-own-sounds) |
| `Assets.make(url, decode)` | Anything else, with `Effect.acquireRelease` for what needs releasing, such as a font |

[`@arcadekit/three`](/reference/three) adds `Three.texture(url)` and `Gltf.model(url)`.

## Load assets for the app's lifetime

Anywhere you have a scope, `Assets.load(bundle)` loads a bundle into it and waits. It loads every asset in parallel, and fails at the first failure with `Assets.Failed`, which names the URL. Use it at the entry point, or in a plugin's `layer`, which keeps what it loads for the app's lifetime:

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

Load anything that needs releasing into a scope. Never load it into a module-level variable, because no scope closes one.

A system can't use `Assets.load`, and one that yields it doesn't compile. A system has no scope to load into but the app's, which would keep what every frame loaded until the app closed. The rules get what a file holds as an action, as [above](#pass-a-files-contents-to-the-rules).

## Hold a bundle yourself

A frame or input-stage system of your own can keep a bundle loaded with `(yield* Assets.Store).hold(bundle, name)`, and let it go with `drop(bundle, name)`. The bundle stays loaded while anyone holds it. A system of the tick can't require the store.

## Choose where files come from

`Assets.Loader` fetches the files. By default it uses `fetch`, and cancels the request when the load is interrupted. In a page, `Browser.runMain` and `Browser.layer` read a path against the document's base, as `fetch` does, so a page with a `<base href>` loads from there. A test serves its files from memory with `Assets.layerMemory({ "/forest.json": "..." })`. A loader of your own marks a failure worth trying again with `transient: true` on its `Assets.Failed`.

## Read more

- [`Assets`](/reference/arcadekit/Assets) in the API reference.
