# arcadekit/content

Loads what a game is played with and drawn from, once per app. `Content` declares a game's content files (heroes, levels, waves) with the Effect Schema that checks them, and `Asset` declares something the app loads once, such as a sprite sheet. Each is a class that keys its own service: `.layer` provides it, and `.load` loads it, keeps the first success, and can be run again after a failure. A content's files come from a `ContentSource`: `ContentSource.fromRecord` serves them from memory, for tests, and `FetchContentSource.fromUrl` in `arcadekit/content/browser` fetches them over HTTP.

An entry of the [`arcadekit`](../../README.md) package. The root entry is DOM-free.

## Install

```bash
pnpm add arcadekit effect
```

Peer dependency: `effect` (~4.1).

## Its modules

| Entry | Export | What it holds | Guide |
| --- | --- | --- | --- |
| `arcadekit/content` | `Content` | A game's content files, declared with the Schema that checks them | [Content and assets](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/content.md) |
| `arcadekit/content` | `Asset` | Something the app loads once for a game, such as a sprite sheet | [Content and assets](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/content.md) |
| `arcadekit/content` | `ContentSource` | Where a content's files come from, read one file at a time, with `fromRecord` for tests and the `ContentError` a read fails with | [Content and assets](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/content.md#a-source-of-the-apps-own) |
| `arcadekit/content/browser` | `FetchContentSource` | `FetchContentSource.fromUrl`, a source that fetches a game's files over HTTP | [Content and assets](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/content.md) |

## Example

A game's levels, declared, then read and checked from memory as a test reads them:

```ts
import { Content, ContentSource } from "arcadekit/content";
import { Schema } from "effect";

export class GameContent extends Content("GameContent", {
  schema: Schema.Struct({ levels: Schema.Array(Schema.String) }),
  files: { levels: "levels.json" },
}) {}

export const checked = GameContent.read(
  ContentSource.fromRecord({ "levels.json": ["#@$.#"] })
);
```
