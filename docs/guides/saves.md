# Saves and settings

A game keeps what lasts between sessions with two declarations of `arcadekit/save`. A `Save` holds its records by id, such as a level's best moves, under one versioned storage key, and a write merges into what is stored, so another tab's records aren't lost. A `Setting` holds one value under its own key, such as the volume, where the last write wins. Neither fails: a save that can't be read is read as empty, a setting as its default, and play goes on.

## A save and a setting

A racing game's best lap per track, and its player's audio settings:

```ts
import { AudioSettings } from "arcadekit/audio";
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
  schema: AudioSettings.AudioSettings,
  default: AudioSettings.defaults,
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

## Defaults and progress

An app may change a default: `default: { ...AudioSettings.defaults, music: 0.4 }`. A setting that holds progress rather than a choice, a value that only grows, says how what is stored and what is written become one, and its `write` then re-reads storage first, as a save's does:

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

## Storage keys and tests

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
