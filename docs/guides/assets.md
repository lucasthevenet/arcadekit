# Assets

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

`Assets.during(condition, bundle)` keeps a bundle loaded while the condition holds, usually a state. From the frame after the game enters the level, the bundle is loading. From the frame after it leaves, it is let go: a picture is closed, and a file still on its way is given up. Entered again, the level loads again.

`yield*` on the bundle gives what the app holds of it: `Absent`, `Loading`, `Ready` with the `assets`, each under its name and with its type, or `Failed` with the error. A bundle that failed is logged once and tried again the next time its level is entered.

## Loading is not part of the simulation

Loading takes real time, so a bundle can be asked for in the frame stage and the input stage only. In a tick it throws. A replay or a server, which draw nothing, load nothing.

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
| `Assets.bytes(url)` | An `ArrayBuffer` |
| `Assets.text(url)` | A string |
| `Assets.json(url, schema)` | A value checked against the schema |
| `Browser.image(url)` | An `ImageBitmap`, closed when let go |
| `Browser.sound(url)` | A `Sound.Clip`, decoded whole. See [sound](sound.md) |
| `Assets.make(url, decode)` | Anything else, with `Effect.acquireRelease` for what has to be let go |

[`@arcadekit/three`](../../packages/three/README.md) adds `Three.texture(url)` and `Gltf.model(url)`.

## Loading for as long as the app

Anywhere there is a scope, `Assets.load(bundle)` loads every asset at once and waits, failing with `Assets.AssetFailed`, which names the URL. That is for the entry point, or a plugin's `layer`, which holds what it loads for as long as the app.

## Where the bytes come from

They come through `Assets.Loader`, which is `fetch` unless told otherwise. A test provides its files in memory with `Assets.layerMemory({ "/forest.json": "..." })`.

## Read more

- [Assets](../../packages/arcadekit/README.md#assets) in the reference.
