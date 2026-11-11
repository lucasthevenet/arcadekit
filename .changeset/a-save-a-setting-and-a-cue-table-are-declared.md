---
"arcadekit": minor
---

A save, a setting and a cue table are declarations. `class MySave extends Save("MySave", { storageKey, field, record, mergeRecord }) {}` and `class MyAudioSettings extends Setting("MyAudioSettings", { storageKey, schema, default }) {}` (`arcadekit/save`): each class is the key of its service, `layer` provides it over a `KeyValueStore`, and the service is a `Stored`, `read` and `write`. `class MyCueTable extends CueTable("MyCueTable", { cues: { hit: SoundId } }) {}` (`arcadekit/audio`): the class is the key of the app's sounds, which `MyCueTable.layer(sounds)` checks and provides. The stored formats and the storage keys are unchanged.

**Breaking**

- `arcadekit/save`: `makeSaveStore`, `SaveStore` and `mergeRecords` are gone. Declare a `Save`: its definition's `key` is `storageKey`; `load` is `read` and `merge(records)` is `write(records)`, which still merges into what is stored, both reached with `yield* MySave`; `mergeRecords(mergeRecord)` is the class's `MySave.merge`. `SaveDefinition` is generic over the record's Schema, and a `field` named `version` is refused.
- `arcadekit/audio`: `makeAudioSettingsStore` and `AudioSettingsStore` are gone, and the entry no longer reads storage. Declare a `Setting` with `schema: AudioSettings` and `default: defaultAudioSettings`; `load` is `read` and `save(settings)` is `write(settings)`, which gives back what it wrote. `AudioSettings`, `defaultAudioSettings` and `applyAudioSettings` stay.
- The log lines name the declaration: `Save "MySave" can't be read. ...`, `Setting "MyAudioSettings" can't be written.`
- A genre's cue table is a `CueTable`. `@arcadekit/push-puzzle/browser` has `PushPuzzleCueTable` in place of `PushPuzzleCueSounds` and the type `PushPuzzleSounds`, and `@arcadekit/survivors/browser` has `SurvivorsCueTable` in place of `SurvivorsCueSounds` and `SurvivorsSounds`. An app gives its sounds with `PushPuzzleCueTable.layer(sounds)` in place of `Layer.succeed(PushPuzzleCueSounds, sounds)`, and names their type `CueSoundsOf<typeof PushPuzzleCueTable>`.
