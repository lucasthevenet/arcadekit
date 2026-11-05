# @arcadekit/content

Loads a game's content files (heroes, levels, waves), validates them with an Effect Schema, and keeps the first successful load. A failed load can be retried. `memorySource` serves files from memory, for tests; `fetchJsonSource` in `@arcadekit/content/browser` fetches them over HTTP.

Part of [arcadekit](https://github.com/lucasthevenet/arcadekit#readme). The root entry is DOM-free.

## Install

```bash
pnpm add @arcadekit/content effect
```

Peer dependency: `effect` (~4.1).

## Example

Levels from `levels.json`, checked by a Schema and by a rule it can't express, behind a service (as `@arcadekit/push-puzzle` does):

```ts
import { makeContentLoader } from "@arcadekit/content";
import type { ContentLoader } from "@arcadekit/content";
import { fetchJsonSource } from "@arcadekit/content/browser";
import { Context, Layer, Schema } from "effect";

const Level = Schema.Struct({
  id: Schema.String,
  rows: Schema.Array(Schema.String),
});
const GameContent = Schema.Struct({ levels: Schema.Array(Level) });
type GameContent = typeof GameContent.Type;

class Content extends Context.Service<Content, ContentLoader<GameContent>>()(
  "my-game/Content"
) {}

export const ContentLayer = Layer.effect(
  Content,
  makeContentLoader({
    schema: GameContent,
    files: { levels: "levels.json" },
    validate: (content) =>
      content.levels.length === 0 ? ["levels.json has no levels"] : [],
    source: fetchJsonSource("/content/"),
  })
);
```

`yield* (yield* Content).load` gives the content, or fails with a `ContentError` whose message names the file and the problem. `loadContent` is the same without the cache.
