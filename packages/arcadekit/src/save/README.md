# arcadekit/save

What a game keeps between sessions. `Save` declares its save: records by id (a level's best moves, a hero's best run) under one versioned storage key. A save's write merges and never replaces: it re-reads the stored save and merges the records it is given into it, so the other ids, and another tab's record, aren't lost. The class keys its own service: `.layer` provides it over a `KeyValueStore`, `read` gives what is stored and `write` stores. Neither fails: a save that can't be read is backed up and read as empty, and storage failures are logged, so play goes on. `BrowserSaveStorage` in `arcadekit/save/browser` is localStorage, or memory if the browser refuses.

An entry of the [`arcadekit`](../../README.md) package. The root entry is DOM-free.

## Install

```bash
pnpm add arcadekit effect @effect/platform-browser
```

Peer dependencies: `effect` (~4.1), and `@effect/platform-browser` (~4.1, an optional peer) for `arcadekit/save/browser` only.

## Example

A racing game's best lap per track:

```ts
import { Save } from "arcadekit/save";
import { BrowserSaveStorage } from "arcadekit/save/browser";
import { Effect, Layer, Schema } from "effect";

// The save: where it is stored, what one record holds, and how two records for one track merge.
export class RaceSave extends Save("RaceSave", {
  storageKey: "my-studio/race/save",
  field: "tracks",
  record: Schema.Struct({ bestLap: Schema.Number, finished: Schema.Boolean }),
  mergeRecord: (a, b) => ({
    bestLap: Math.min(a.bestLap, b.bestLap),
    finished: a.finished || b.finished,
  }),
}) {}

// The app says where it is stored. Building the layer reads nothing.
export const resources = RaceSave.layer.pipe(Layer.provide(BrowserSaveStorage));

// A lap is written into the save: merged with what is stored, so the other tracks stay.
// `write` gives every record after the merge.
export const recordLap = (track: string, seconds: number) =>
  Effect.gen(function* () {
    const save = yield* RaceSave;
    return yield* save.write({ [track]: { bestLap: seconds, finished: true } });
  });

// The same merge with no storage, for what the screen shows before the write is back.
export const shown = RaceSave.merge(
  { oval: { bestLap: 61.2, finished: true } },
  { oval: { bestLap: 58.9, finished: true } }
);
```

The stored save is `{ "version": 1, "tracks": { ... } }` under `storageKey`, and one that can't be decoded is copied to `<storageKey>/corrupt` before it is dropped. `read` reads storage each time and keeps nothing, so it gives what another tab wrote.

Give each save a storage key of its own: two saves under one key overwrite each other, and nothing refuses it. A save works over any Effect `KeyValueStore`, so tests provide `KeyValueStore.layerMemory`. See [ADR-0009](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0009-a-save-package-is-earned.md).
