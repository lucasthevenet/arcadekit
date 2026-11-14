# arcadekit/save

What a game keeps between sessions. `Save` declares its save: records by id (a level's best moves, a hero's best run) under one versioned storage key. A save's write merges into what it could read: it re-reads the stored save and merges the records it is given into it, so the other ids, and another tab's record, aren't lost. `Setting` declares one value kept apart from the save, under its own key, where the last write wins: the player's volume and mute, their controls. Each is a class that keys its own service, a `Stored.Stored`: `.layer` provides it over a `KeyValueStore`, `read` gives what is stored and `write` stores. Neither fails: a save that can't be read is backed up and read as empty, a setting as its `default`, and storage failures are logged, so play goes on. `BrowserSaveStorage.layer` in `arcadekit/save/browser` is localStorage, or memory if the browser refuses.

An entry of the [`arcadekit`](../../README.md) package. The root entry is DOM-free.

## Install

```bash
pnpm add arcadekit effect @effect/platform-browser
```

Peer dependencies: `effect` (~4.1), and `@effect/platform-browser` (~4.1, an optional peer) for `arcadekit/save/browser` only.

## Its modules

| Entry | Export | What it holds | Guide |
| --- | --- | --- | --- |
| `arcadekit/save` | `Save` | A game's records by id, under one versioned storage key | [Saves and settings](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/saves.md) |
| `arcadekit/save` | `Setting` | One value kept apart from the save, under its own key | [Saves and settings](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/saves.md) |
| `arcadekit/save` | `Stored` | What a save's or a setting's service gives: `read` and `write` | [Saves and settings](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/saves.md) |
| `arcadekit/save/browser` | `BrowserSaveStorage` | `BrowserSaveStorage.layer`: localStorage, or memory if the browser refuses | [Saves and settings](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/saves.md) |

## Example

A racing game's best lap per track. A write is merged into what is stored, so the other tracks stay:

```ts
import { Save } from "arcadekit/save";
import { BrowserSaveStorage } from "arcadekit/save/browser";
import { Effect, Layer, Schema } from "effect";

export class RaceSave extends Save("RaceSave", {
  storageKey: "my-studio/race/save",
  record: Schema.Struct({ bestLap: Schema.Number }),
  mergeRecord: (a, b) => (a.bestLap <= b.bestLap ? a : b),
}) {}

export const recordLap = (track: string, seconds: number) =>
  Effect.gen(function* () {
    const save = yield* RaceSave;
    return yield* save.write({ [track]: { bestLap: seconds } });
  }).pipe(
    Effect.provide(RaceSave.layer.pipe(Layer.provide(BrowserSaveStorage.layer)))
  );
```
