# arcadekit/content

Loads what a game is played with and drawn from, once per app. `Content` declares a game's content files (heroes, levels, waves) with the Effect Schema that checks them, and `Asset` declares something the app loads once, such as a sprite sheet. Each is a class that keys its own service: `.layer` provides it, and `.load` loads it, keeps the first success, and can be run again after a failure. `memorySource` serves files from memory, for tests; `fetchJsonSource` in `arcadekit/content/browser` fetches them over HTTP.

An entry of the [`arcadekit`](../../README.md) package. The root entry is DOM-free.

## Install

```bash
pnpm add arcadekit effect
```

Peer dependency: `effect` (~4.1).

## Example

Levels from `levels.json`, checked by a Schema and by a rule it can't express, and a sheet the app loads once (as `@arcadekit/push-puzzle` does):

```ts
import { Asset, Content, memorySource } from "arcadekit/content";
import { fetchJsonSource } from "arcadekit/content/browser";
import { Data, Effect, Layer, Schema } from "effect";

const Level = Schema.Struct({
  id: Schema.String,
  rows: Schema.Array(Schema.String),
});

// The genre declares its content: the Schema, the file each part comes from, and extra checks.
export class GameContent extends Content("GameContent", {
  schema: Schema.Struct({ levels: Schema.Array(Level) }),
  files: { levels: "levels.json" },
  validate: (content) =>
    content.levels.length === 0 ? ["levels.json has no levels"] : [],
}) {}

class SheetError extends Data.TaggedError("SheetError")<{
  readonly message: string;
}> {}
interface Sheet {
  readonly image: ImageBitmap;
}

// And an asset, with how to free it. The type and the error come first.
export class GameSheet extends Asset<Sheet, SheetError>()("GameSheet", {
  release: (sheet) => sheet.image.close(),
}) {}

// The app says where each comes from. Building the layers loads nothing.
export const resources = Layer.mergeAll(
  GameContent.layer(fetchJsonSource("/content/")),
  GameSheet.layer(
    Effect.tryPromise({
      try: async () => {
        const response = await fetch("/sprites/sheet.png");
        return { image: await createImageBitmap(await response.blob()) };
      },
      catch: (cause) => new SheetError({ message: String(cause) }),
    })
  )
);

// Anything loads them. The first success is kept; a failed load can be run again.
export const loadEverything = Effect.all([GameContent.load, GameSheet.load], {
  concurrency: "unbounded",
});

// A test reads the game's files with the same checks, and keeps nothing.
export const checked = GameContent.read(
  memorySource({ "levels.json": [{ id: "first", rows: ["#@$.#"] }] })
);
```

`GameContent.load` gives the content, or fails with a `ContentError` whose message names the file and the problem. Each class is the type of its own service, so a requirement reads `Effect.Effect<A, E, GameContent | GameSheet>`.

A [`Game.Engine`](../game/README.md) names what it draws from in `uses` (`uses: { sheet: GameSheet.load }`), so each attach loads the sheet or takes the one already loaded, and the app's loading screen runs the same `GameSheet.load` to show a failure and retry.

`loadOnce(load, release)` is what both are built on: a `load` that keeps its first success for as long as its scope is open. `loadContent` reads and checks the files once, with nothing kept: it is what a `Content` declaration loads with. `makeContentLoader` is the older, undeclared form of the service, which no game uses any more.
