---
title: "Snapshots"
description: "A snapshot is a world written to bytes, which a world loads to go on exactly as the world it was taken from. Saves are built on snapshots."
---

A **snapshot** is a world written to bytes: everything the world holds, which a world loads to go on exactly as the one it was taken from. A [save](saving-and-loading.md) holds its game's world as a snapshot.

## Snapshot a world and load it

```ts
import { Component, Field } from "arcadekit";
import { World } from "arcadekit/ecs";

const Position = Component.define("game/Position", {
  x: Field.f32,
  y: Field.f32,
});

const world = new World();
world.spawn(Position.of({ x: 1, y: 2 }));
const bytes = world.snapshot(); // a Uint8Array

const copy = new World();
copy.load(bytes);
copy.hash() === world.hash(); // true
```

`world.snapshot()` writes the whole world to bytes: every table and sparse set, the singletons that have been written, the upcoming entity ids, the random generator's state, and in an app's world the actions queued for the next tick and the events waiting to be read. A world that loads the bytes hashes the same and goes on the same way: the same iteration order, the same ids for new entities, the same random numbers. Saves are built on snapshots.

- **Its size is close to the data's.** A numeric column is written as its raw bytes, so an entity with two `f32` fields takes 20 bytes: 8 for the id, 8 for the floats and 4 for the generation. With four float fields, taking a snapshot costs 7 ns per entity and loading it 21 ns.
- **Components are stored by name**, with their field names and types, so a snapshot doesn't depend on the order a program defines its components in. `load` finds each one by its name among the components the program defines, and refuses a snapshot that holds one it doesn't.
- **Non-numeric fields are saved as [their type specifies](components.md#choose-a-field-type).** In a `json` field, strings, numbers, booleans, bigints, `null` and `undefined` round-trip exactly, `-0` and `NaN` included, while arrays and objects go through JSON text. A `schema` or `ref` field is saved in its encoded form, and a `transient` field not at all.
- **`load` fills an empty world**: one that has never held an entity or written a singleton, and holds no queued action or waiting event. A world loads what an app's stores held only when it is that app's. A world of the storage core alone, made with `new World()` of `arcadekit/ecs`, refuses a snapshot that holds queued actions or waiting events, with `"unknown store"`.
- **`world.restore(bytes)` replaces everything in a world in use with a snapshot**, for 16 ns per entity. It is meant for a snapshot the world took itself, or one from a world built the same way. Afterwards, the world is what a new world loaded from the snapshot would be. In an app's world, that includes the game's time, the queued actions, the waiting events, and each system's place in them and in what changed. Singleton values keep their object identity, and `world.random` stays the same generator. A view or `removed` reader obtained before throws when used, asking to be obtained again, as a system does every tick. In a world with no app, pending changes for change queries are dropped: `world.restoreChanges` restores what `world.saveChanges` returned.
- **The format is versioned.** This version writes format 4, and also reads formats 1 to 3.

Every failure of `snapshot`, `load` or `restore` is a `SnapshotError` of `arcadekit/ecs`. Its `problem` is one of the table's, except the four only a save has: `"not a save"`, `"newer version"`, `"no migration"` and `"migration failed"`. It can also be one of two more:

- `"world not empty"`, from `load`.
- `"cannot be saved"`, when a field, a queued action or a waiting event holds a value with no saved form, or a spawn is queued on a `CommandBuffer` and not applied.

`load` refuses damaged bytes rather than trusting them. It checks every count against the bytes left before it allocates anything for it, refuses an entity in two rows or in a freed slot, and refuses text that isn't valid. A damaged number inside a column looks like any other number, and loads as that number.

`readSnapshot` and `writeSnapshot` of `arcadekit/ecs` turn a snapshot into a plain description and back, without component definitions, for tools that inspect or edit snapshots.

## Read more

- [Saving and loading](saving-and-loading.md), for a game's saves, which are built on snapshots.
- The world's [`snapshot`](/reference/arcadekit/ecs#world) in the API reference.
