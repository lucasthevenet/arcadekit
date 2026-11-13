# arcadekit/content

Loads what a game is played with and drawn from, once per app. `Content` declares a game's content files (heroes, levels, waves) with the Effect Schema that checks them, and `Asset` declares something the app loads once, such as a sprite sheet. Each is a class that keys its own service: `.layer` provides it, and `.load` loads it, keeps the first success, and can be run again after a failure. A content's files come from a `ContentSource`: `ContentSource.fromRecord` serves them from memory, for tests, and `FetchContentSource.fromUrl` in `arcadekit/content/browser` fetches them over HTTP.

An entry of the [`arcadekit`](../../README.md) package. The root entry is DOM-free.

## Install

```bash
pnpm add arcadekit effect
```

Peer dependency: `effect` (~4.1).

## Example

Levels from `levels.json`, checked by a Schema and by a rule it can't express, and a sheet the app loads once (as `@arcadekit/push-puzzle` does):

```ts
import { Asset, Content, ContentSource } from "arcadekit/content";
import { FetchContentSource } from "arcadekit/content/browser";
import { Effect, Layer, Schema } from "effect";

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

class SheetError extends Schema.TaggedError<SheetError>()("SheetError", {
  message: Schema.String,
}) {}
interface Sheet {
  readonly image: ImageBitmap;
}

// And an asset, with how to free it. The type and the error come first.
export class GameSheet extends Asset<Sheet, SheetError>()("GameSheet", {
  release: (sheet) => sheet.image.close(),
}) {}

// The app says where each comes from. Building the layers loads nothing.
export const resources = Layer.mergeAll(
  GameContent.layer(FetchContentSource.fromUrl("/content/")),
  GameSheet.layer(
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch("/sprites/sheet.png", { signal });
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
  ContentSource.fromRecord({
    "levels.json": [{ id: "first", rows: ["#@$.#"] }],
  })
);
```

`GameContent.load` gives the content, or fails with a `ContentSource.ContentError` whose message names the file and the problem: an app catches it by its tag, `Effect.catchTag("ContentError", ...)`. Each class is the type of its own service, so a requirement reads `Effect.Effect<A, E, GameContent | GameSheet>`, and a trace shows each load as `GameContent.load` and each read of the files as `GameContent.read`.

A [`Game.Engine`](../game/README.md) names what it draws from in `uses` (`uses: { sheet: GameSheet.load }`), so each attach loads the sheet or takes the one already loaded, and the app's loading screen runs the same `GameSheet.load` to show a failure and retry.

## A source of the app's own

A content source is a read of one file by its name. `ContentSource.make` makes one from that read, which fails with a `ContentError` for a file it can't give; `ContentSource.read` reads one file of any source:

```ts
import { ContentSource } from "arcadekit/content";
import { Effect } from "effect";

// The files the app was built with, as JSON text. A parse that throws is a ContentError.
const texts: Readonly<Record<string, string>> = {
  "levels.json": '[{ "id": "first", "rows": ["#@$.#"] }]',
};
const bundled = ContentSource.make((file) =>
  Effect.try({
    try: () => JSON.parse(texts[file] ?? ""),
    catch: (cause) =>
      new ContentSource.ContentError({
        message: `Could not read ${file}: ${String(cause)}`,
        cause,
      }),
  })
);

// A player's mods first, and the game's own files for what the mods don't change.
export const withMods = (mods: ContentSource.ContentSource) =>
  ContentSource.make((file) =>
    ContentSource.read(mods, file).pipe(
      Effect.catchTag("ContentError", () => ContentSource.read(bundled, file))
    )
  );
```

A content's `read(source)` reads and checks every file once and keeps nothing, and its `layer(source)` keeps the first success for the app: both read through the source.
