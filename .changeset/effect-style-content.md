---
"arcadekit": minor
---

`arcadekit/content` is written as Effect's modules are ([ADR-0024](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0024-the-kit-is-written-as-effect-modules.md)). `Content` and `Asset` keep their builders, and a game declares them as before. Where a content's files come from is the namespace `ContentSource`: a data type with a `TypeId`, its `make`, `fromRecord`, an `isContentSource` guard, `pipe`, a printed form, and `read`, which takes the source first and, given the file alone, returns the function a `pipe` applies. Its error, `ContentSource.ContentError`, is a `Schema.TaggedError`. The browser's source is `FetchContentSource.fromUrl` in `arcadekit/content/browser`. **Breaking**: every export but the two builders and their types is renamed or reshaped.

A content loads and checks its files as it did: every file at once, then the Schema, then `validate`, with the same messages, and the first success kept for the app. What changed besides the names:

- **A content source is a value, not a function.** Make one with `ContentSource.make(read)`, and read a file of one with `ContentSource.read(source, file)`. A function of a file's name is no longer a source, and a declaration's `layer` and `read` refuse one as a type error.
- **A content error can keep what was thrown.** `ContentError` has an optional `cause` beside its `message`: a source that wraps a throw (a failed `fetch`, a parse) keeps it there. An app still catches it by its tag, `Effect.catchTag("ContentError", ...)`, which didn't change.
- **The fetch source aborts what it no longer needs.** An interrupted read aborts its request, where before the request ran on. A response that isn't a success fails with `Could not load levels.json: HTTP 404` (it was `... : Error: HTTP 404`), and a body that isn't JSON with `Could not read levels.json as JSON: ...`. Each failure of a request keeps what `fetch` threw as its `cause`.
- **Loads and reads are traced.** A trace shows each `load` as `<Name>.load` (`PushPuzzleContent.load`, `PushPuzzleSheet.load`), each reading of a content's files as `<Name>.read`, and each file a source reads as `ContentSource.read`. A failure from them carries those spans in its cause's annotations, so a test that compares a whole `Exit` with `Exit.fail(error)` now compares the cause's reasons, or the error itself (`Effect.flip`).
- **A record source serves only its own keys.** `ContentSource.fromRecord({})` has no file named `"constructor"`, which `memorySource` found on the object's prototype.

```ts
import { readFileSync } from "node:fs";

import { ContentSource } from "arcadekit/content";
import { FetchContentSource } from "arcadekit/content/browser";
import { Effect } from "effect";

import { RaceContent } from "./content";

// In the app. Before: RaceContent.layer(fetchJsonSource("/content/"))
export const contentLayer = RaceContent.layer(
  FetchContentSource.fromUrl("/content/")
);

// In a test. Before: const fileSource: ContentSource = (file) => Effect.try({ ... })
const fileSource = ContentSource.make((file) =>
  Effect.try({
    try: () =>
      JSON.parse(readFileSync(new URL(file, import.meta.url), "utf-8")),
    // Before: new ContentError({ message: String(cause) })
    catch: (cause) =>
      new ContentSource.ContentError({ message: String(cause), cause }),
  })
);
export const shipped = RaceContent.read(fileSource);

// Before: RaceContent.read(memorySource({ "tracks.json": [] }))
export const empty = RaceContent.read(
  ContentSource.fromRecord({ "tracks.json": [] })
);
```

**Breaking**

Every export of `arcadekit/content` and `arcadekit/content/browser` before, and what a game writes now:

| Before | Now |
| --- | --- |
| `ContentSource`, a function `(file) => Effect<unknown, ContentError>` | `ContentSource.ContentSource`, a value made with `ContentSource.make((file) => ...)` |
| calling a source, `source(file)` | `ContentSource.read(source, file)`, or `source.pipe(ContentSource.read(file))` |
| `memorySource(files)` | `ContentSource.fromRecord(files)` |
| `ContentError`, a `Data.TaggedError` with a `message` | `ContentSource.ContentError`, a `Schema.TaggedError` with a `message` and an optional `cause` |
| `fetchJsonSource(baseUrl)` (`arcadekit/content/browser`) | `FetchContentSource.fromUrl(baseUrl)` (`arcadekit/content/browser`) |
| `loadOnce(load, release)`, what `Content` and `Asset` are built on | Gone: a declaration's `layer` is the one way to keep a load's first success. Declare an `Asset` for anything an app loads once |

And what follows from the shape: a source is not a function, so `ContentSource.isContentSource(value)` tells one apart. `Content`, `Asset`, `ContentClass`, `ContentDefinition`, `ContentId`, `ContentService`, `AssetClass`, `AssetId`, `AssetService` and `Loaded` keep their names; `ContentClass`'s `layer` and `read` take a `ContentSource.ContentSource`, and `ContentDefinition` is exported from the same file as `Content`.
