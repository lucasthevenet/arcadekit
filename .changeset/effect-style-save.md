---
"arcadekit": minor
---

`arcadekit/save` is written as Effect's modules are ([ADR-0024](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0024-the-kit-is-written-as-effect-modules.md)). `Save` and `Setting` keep their builders, and a game declares a setting as before. What their services give is the namespace `Stored`: `Stored.Stored`, a value with a `TypeId`, its `make`, an `isStored` guard, `pipe` and a printed form. The browser's storage is `BrowserSaveStorage.layer` in `arcadekit/save/browser`. **Breaking**: a save's definition has no `field`, its stored format changed, and `Stored` and `BrowserSaveStorage` are namespaces.

A save and a setting read, write, merge, back up and log as they did, with the same messages. What changed besides the names:

- **A save is stored as `{ "version": 1, "records": { ... } }`.** Its records sat under a field the game named (`levels`, `heroes`), which kept each app's stored format as it was. A save stored that way no longer decodes: it is copied to `<storageKey>/corrupt`, logged, and read as empty, as a corrupt save is. The storage keys and a setting's format are as they were.
- **A declaration's writes run one at a time.** A write re-reads what is stored, merges and stores. Two writes of one save at once could both read the same stored save, and the second stored over the first's record; now the second waits for the first. Over localStorage and `KeyValueStore.layerMemory` nothing waited between the read and the store, so no app lost a record this way.
- **Reads and writes are traced.** A trace shows each read as `<Name>.read` (`PushPuzzleSave.read`) and each write as `<Name>.write`, with the read a merge makes inside it.
- **A stored value is data.** `Stored.isStored(value)` tells a save's or a setting's service from an object with a `read` and a `write`, and `Stored.make({ read, write })` makes one, for a test of an app's own code that wants the service with no storage under it.

```ts
import { Save, Stored } from "arcadekit/save";
import { BrowserSaveStorage } from "arcadekit/save/browser";
import { Effect, Layer, Schema } from "effect";

// Before: field: "tracks", and the save stored as { version: 1, tracks: { ... } }.
export class RaceSave extends Save("RaceSave", {
  storageKey: "my-studio/race/save",
  record: Schema.Struct({ bestLap: Schema.Number }),
  mergeRecord: (a, b) => (a.bestLap <= b.bestLap ? a : b),
}) {}

// Before: Layer.provide(BrowserSaveStorage)
export const saveLayer = RaceSave.layer.pipe(
  Layer.provide(BrowserSaveStorage.layer)
);

// Before: Layer.succeed(RaceSave, { read, write }), an object of the app's own.
export const noStorage = Layer.succeed(
  RaceSave,
  Stored.make({ read: Effect.succeed({}), write: Effect.succeed })
);
```

**Breaking**

Every export of `arcadekit/save` and `arcadekit/save/browser` before, and what a game writes now:

| Before | Now |
| --- | --- |
| `Save("MySave", { storageKey, field, record, mergeRecord })` | `Save("MySave", { storageKey, record, mergeRecord })`: there is no `field` |
| `SaveDefinition<S, Field>` | `SaveDefinition<S>` |
| the stored save `{ "version": 1, "<field>": { ... } }` | `{ "version": 1, "records": { ... } }`; one stored the old way is backed up to `<storageKey>/corrupt` and read as empty |
| `Stored<A>`, a type | `Stored.Stored<A>`, the interface of the namespace `Stored`, with a `TypeId` |
| an object of the app's own as a save's or a setting's service | `Stored.make({ read, write })`, which `Stored.isStored` recognises |
| `BrowserSaveStorage`, a Layer (`arcadekit/save/browser`) | `BrowserSaveStorage.layer` (`arcadekit/save/browser`) |

`Save`, `SaveClass`, `SaveId`, `SaveService`, `Records`, `Setting`, `SettingClass`, `SettingDefinition`, `SettingId` and `SettingService` keep their names, and so do a class's `kind`, `saveName`, `settingName`, `definition`, `merge` and `layer`, and a service's `read` and `write`. Neither `read` nor `write` fails, as before.
