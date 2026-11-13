# arcadekit/save

What a game keeps between sessions. `Save` declares its save: records by id (a level's best moves, a hero's best run) under one versioned storage key. A save's write merges into what it could read: it re-reads the stored save and merges the records it is given into it, so the other ids, and another tab's record, aren't lost. `Setting` declares one value kept apart from the save, under its own key, where the last write wins: the player's volume and mute, their controls. Each is a class that keys its own service, a `Stored.Stored`: `.layer` provides it over a `KeyValueStore`, `read` gives what is stored and `write` stores. Neither fails: a save that can't be read is backed up and read as empty, a setting as its `default`, and storage failures are logged, so play goes on. `BrowserSaveStorage.layer` in `arcadekit/save/browser` is localStorage, or memory if the browser refuses.

An entry of the [`arcadekit`](../../README.md) package. The root entry is DOM-free.

## Install

```bash
pnpm add arcadekit effect @effect/platform-browser
```

Peer dependencies: `effect` (~4.1), and `@effect/platform-browser` (~4.1, an optional peer) for `arcadekit/save/browser` only.

## Example

A racing game's best lap per track, and its player's audio settings:

```ts
import { AudioSettings, defaultAudioSettings } from "arcadekit/audio";
import { Save, Setting } from "arcadekit/save";
import { BrowserSaveStorage } from "arcadekit/save/browser";
import { Effect, Layer, Schema } from "effect";

// The save: where it is stored, what one record holds, and how two records for one track merge.
export class RaceSave extends Save("RaceSave", {
  storageKey: "my-studio/race/save",
  record: Schema.Struct({ bestLap: Schema.Number, finished: Schema.Boolean }),
  mergeRecord: (a, b) => ({
    bestLap: Math.min(a.bestLap, b.bestLap),
    finished: a.finished || b.finished,
  }),
}) {}

// A setting: one value under its own key, and what it is before anything is stored.
export class RaceAudioSettings extends Setting("RaceAudioSettings", {
  storageKey: "my-studio/race/settings",
  schema: AudioSettings,
  default: defaultAudioSettings,
}) {}

// The app says where they are stored. Building the layers reads nothing.
export const resources = Layer.mergeAll(
  RaceSave.layer,
  RaceAudioSettings.layer
).pipe(Layer.provide(BrowserSaveStorage.layer));

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

// A setting is read at startup and written when the player changes it.
export const mute = Effect.gen(function* () {
  const setting = yield* RaceAudioSettings;
  const settings = yield* setting.read;
  return yield* setting.write({ ...settings, muted: true });
});
```

The stored save is `{ "version": 1, "records": { ... } }` under `storageKey`, and one that can't be decoded is copied to `<storageKey>/corrupt` before it is dropped. A setting is stored as its Schema encodes it. `read` reads storage each time and keeps nothing, so it gives what another tab wrote. A declaration's writes run one at a time, so two writes of one save at once both land. A trace shows each read and write under the declared name: `RaceSave.read`, `RaceSave.write`.

An app may change a default: `default: { ...defaultAudioSettings, music: 0.4 }`. A setting that holds progress rather than a choice, a value that only grows, says how what is stored and what is written become one, and its `write` then re-reads storage first, as a save's does:

```ts
import { Setting } from "arcadekit/save";
import { Schema } from "effect";

export class RaceTutorial extends Setting("RaceTutorial", {
  storageKey: "my-studio/race/tutorial",
  schema: Schema.Struct({ offered: Schema.Boolean, completed: Schema.Boolean }),
  default: { offered: false, completed: false },
  merge: (stored, written) => ({
    offered: stored.offered || written.offered,
    completed: stored.completed || written.completed,
  }),
}) {}
```

Give each save and each setting a storage key of its own: two declarations under one key overwrite each other, and nothing refuses it. Both work over any Effect `KeyValueStore`, so a test provides `KeyValueStore.layerMemory` and reads what was stored:

```ts
import { Save } from "arcadekit/save";
import { Effect, Layer, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";

export class RaceSave extends Save("RaceSave", {
  storageKey: "my-studio/race/save",
  record: Schema.Struct({ bestLap: Schema.Number }),
  mergeRecord: (a, b) => (a.bestLap <= b.bestLap ? a : b),
}) {}

export const stored = Effect.gen(function* () {
  const save = yield* RaceSave;
  yield* save.write({ oval: { bestLap: 61.2 } });
  return yield* (yield* KeyValueStore.KeyValueStore).get("my-studio/race/save");
}).pipe(
  Effect.provide(
    RaceSave.layer.pipe(Layer.provideMerge(KeyValueStore.layerMemory))
  )
);
// '{"version":1,"records":{"oval":{"bestLap":61.2}}}'
```

See [ADR-0009](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0009-a-save-package-is-earned.md).
