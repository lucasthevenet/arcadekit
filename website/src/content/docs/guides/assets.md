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
  const forest = yield* Assets.Status(Forest); // the bundle's current status
  if (forest._tag === "Ready") {
    const picture: ImageBitmap = forest.assets.backdrop;
  }
});

const Game = Plugin.make("game/Game", {
  plugins: [Assets.plugin],
  systems: [
    Assets.during(Forest).pipe(System.runIf(State.is(Level, "forest"))),
    Draw,
  ],
});
```

`Assets.during(bundle)` gives a level its scope. It makes a system that keeps a bundle loaded, and `System.runIf` gives it the condition to keep it loaded while, as for any system, usually a state. With no condition, the bundle stays loaded until the app is closed. From the frame after the game enters the level, the bundle loads in a scope of its own. From the frame after the game leaves, that scope closes. Images are closed, and downloads still running are cancelled. Entering the level again loads the bundle again.

- Use one `Assets.during` per bundle. To keep a bundle loaded across several states, give a condition that holds in each.
- The system runs in `"preFrame"`, the stage before the frame's own. Every frame system sees the bundle in the same status, whatever order the systems are listed in.
- Anything still loaded when the app is closed is released with it.

`yield* Assets.Status(bundle)` gives a bundle's current status: `Absent`, `Loading`, `Ready`, or `Failed`. `Ready` holds the `assets`, each under its name and with its type, and `Failed` holds the error. `Assets.match(status, { Absent, Loading, Ready, Failed })` returns what the function of its case returns, as a HUD that says how a level is loading needs. The store logs a failed bundle once, keeps nothing of what did load, and retries it the next time its level is entered.

## Share files between bundles

Bundles that are held at the same time share what they load. A file named by two of them is fetched once, and kept while either is loaded. An asset that two of them have, the same value in each, is decoded once, and released when the last of them is let go. An asset made twice, such as `Browser.image("/forest.png")` written in two bundles, is decoded once for each, from the one fetch.

A fetch that may succeed if tried again is tried again, up to three times, 200, 400 and 800 milliseconds later. That is a request that got no answer, a download that was cut off, or a server that answered 500 or more. Its bundle stays `Loading` meanwhile, and becomes `Ready` if one of them succeeds, with no need to enter its level again. A missing file, an answer of 404, or a file that doesn't decode fails at once.

## Pass a file's contents to the rules

Loading takes real time, so only the frame and input stages can request a bundle. A system of the tick can't require `Assets.Store`. A replay or a server draws nothing, loads nothing, and runs the same game.

A load receives the services the app was given from outside, but none of the app's own. Nothing it does counts as part of the game. The random numbers that a loader draws to back off before a retry don't come from the world.

When the rules need something from a file, such as where the walls are, pass it to them as an action. `Assets.onReady(bundle, rules, payload)` makes a plugin that does it: once the bundle is loaded, an input-stage system issues an action with a payload made from its assets, and `rules`, a handler of yours, applies it. From then on the contents are in the log, and a replay has them without the file:

```ts sketch
const build = Action.handler(Build, function* (layout) {
  /* … */
});
const Begin = Assets.onReady(Forest, build, ({ layout }) => layout);
```

List the plugin in your game's `plugins`, and `build` nowhere else. The world records what it was handed, and that record holds the rest:

- `rules` runs once for each time the world is handed the bundle, so the game writes no check of its own against handing it over twice. A level whose file spawns nothing is handed over once, like any other.
- An app made from a save has the record, and doesn't hand the level over again when its bundle loads.
- A rewind to before a handover hands it over again, once.
- In a [session](sessions.md), every peer whose bundle loads issues the action, and the first one applied counts, on every peer. A peer that fails to load holds nobody up, and its bundle is `Failed`.
- `Assets.forget(bundle)`, in code of the tick, makes the world forget the handover, so that the bundle is handed over again, as when a new run starts.

## Make a game of several levels

A game whose levels are files gives each level a bundle with `Assets.family`, and adds a level by adding its file:

```ts
import {
  Action,
  Assets,
  Commands,
  Component,
  Field,
  Plugin,
  Query,
  Singleton,
} from "arcadekit";
import { Effect, Schema } from "effect";

const Layout = Schema.Struct({ walls: Schema.Array(Schema.Int) });
const Wall = Component.define("game/Wall", { at: Field.i32 });
const Progress = Singleton.define(
  "game/Progress",
  { level: Field.i32 },
  { level: 1 }
);

// /levels/1.json, /levels/2.json, and so on: one bundle for each level's number.
const Levels = Assets.family("game/Level", (level: number) => ({
  layout: Assets.json(`/levels/${level}.json`, Layout),
}));
const level = Effect.map(
  Singleton.Read(Progress),
  (progress) => progress.level
);

const Build = Action.define("game/Build", Layout);
const Next = Action.define("game/Next");

// A level replaces the one before it.
const build = Action.handler(Build, function* ({ walls }) {
  const commands = yield* Commands.spawns(Wall);
  (yield* Query.View(Query.all(Wall))).each((_, wall) =>
    commands.despawn(wall)
  );
  for (const at of walls) {
    commands.spawn(Wall.of({ at }));
  }
});

const Game = Plugin.make("game/Game", {
  plugins: [Assets.onReady(Levels, level, build, ({ layout }) => layout)],
  handlers: [
    Action.handler(Next, function* () {
      (yield* Singleton.Write(Progress)).level += 1;
    }),
  ],
  systems: [Assets.during(Levels, level)],
});
```

- `Levels.of(3)` is the bundle of the third level, named `"game/Level(3)"`, and the same bundle each time it is asked for.
- `Assets.during(Levels, level)` keeps the bundle of the level the game is at loaded. When `Progress.level` changes, it lets go of the bundle before and loads the next one.
- `Assets.onReady(Levels, level, build, payload)` hands the bundle of the level the game is at to the rules once it is loaded. The world records the level it was last handed, so going from level 1 to 2 and back hands each over as the game comes to it, and `payload` is given the level as its second argument.
- The level's entities are the game's: here, the walls, which `build` despawns before it spawns the next level's. A level is a number in the world, so neither a state nor a bundle names it.

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

`Assets.Loader` fetches the files. By default it uses `fetch`, and cancels the request when the load is interrupted. In a page, `Browser.runMain` and `Browser.layer` read a path against the document's base, as `fetch` does, so a page with a `<base href>` loads from there. A test serves its files from memory with `Assets.layer(Assets.makeMemory({ "/forest.json": "..." }))`. A loader of your own marks a failure worth trying again with `transient: true` on its `Assets.Failed`.

## Read more

- [`Assets`](/reference/arcadekit/Assets) in the API reference.
