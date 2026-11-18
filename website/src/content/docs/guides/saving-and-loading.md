---
title: "Saving and loading"
description: "A save holds a game between two ticks, and a game loaded from it goes on exactly as the saved one did. This guide covers saving, loading, and bringing an old save up to date."
---

A save holds a game between two ticks, and a game loaded from it goes on exactly as the saved one did. This guide covers saving, loading, and bringing an old save up to date.

## Saving

```ts
import { App, Component, Field, Plugin, Save } from "arcadekit";
import { Effect, Exit } from "effect";

const Position = Component.define("game/Position", { x: Field.f32 });
const Rules = Plugin.make("game/Rules", { components: [Position] });

const program = Effect.gen(function* () {
  const app = yield* App.make({ plugins: [Rules] });
  app.world.spawn(Position.of({ x: 3 }));
  app.tick(1 / 60);

  const saved = app.save(); // Exit<Save, SaveRefused>
  if (Exit.isFailure(saved)) {
    return;
  }
  const bytes = Save.encode(saved.value); // a Uint8Array, for a file

  const read = Save.decode(bytes); // Exit<Save, LoadRefused>
  if (Exit.isSuccess(read)) {
    const again = yield* App.load(read.value, { plugins: [Rules] });
    again.world.hash() === app.world.hash(); // true
  }
}).pipe(Effect.scoped);
```

A save is taken between two ticks. It holds the world as a [snapshot](#snapshots-on-their-own), the game's time, the actions waiting for the next tick, the simulation's own among them, the events waiting to be read and how far each system had read them, and what change queries had yet to visit.

It is the snapshot and a little text: for 100,000 entities with four float fields, 2.8 MB and about 0.7 ms to take.

`App.load` takes the plugins and options the game was made with. No plugin's `setup` runs: the save holds what setup did. `App.run` takes a `save` too, to start a page from one.

To come back to a moment of the same app, in the same run of the program, `app.capture()` and `app.rewind(moment)` do it in memory, and what waits needs no schema. See [`App`](/reference/arcadekit/App).

## What a game has to do

- **List its components.** A world knows a component by its name, so every component, singleton and state a save names has to be in some plugin's `components`. A load that meets one that isn't fails and names it.
- **Keep scripts' progress in the world.** A save can't hold a script in mid-flight. A plugin's `scripts` start again from their beginning after a load, so a script picks up from what it finds in the world. A script started by hand, with `app.spawnScript` or `Script.spawn`, isn't started again: whoever loads the game starts it.
- **Give what waits a schema.** An action or event that is waiting is saved in its JSON form, so one defined with no schema can't be.
- **Save after a tick.** A game can't be saved while commands are queued and not applied. A tick applies them at its end.

When one of these two is in the way, or a field holds a value it can't save, `app.save()` fails with `Save.SaveRefused`, whose message names it.

What isn't saved: a `Field.transient` field, which is undefined after a load, and what a service of the game's own holds.

## A save is a snapshot plus the log since

The save says how long the log was, `save.logLength`. A game that keeps its last save and the actions logged after it can come back to the present by loading the save and replaying only that tail, which costs the same however long the game has run:

```ts sketch
const app = yield * App.load(save, { plugins: [Rules] });
App.replay(app, log.slice(save.logLength), { delta: 1 / 60, ticks });
```

`ticks` is how many ticks the game ran after the save: its tick now, less `save.tick`. The loaded app's own log starts empty.

The [replay](replays.md) checks itself against the tail's checkpoints, so a save that didn't bring the game back faithfully is caught at the next one.

## Versions and migrations

A game has a `version`, a whole number it raises when it changes its components or what its saves hold, 0 when it gives none. A save records the version that wrote it. One of the game's own version loads as it is. An older one is brought up one version at a time, by the migration `from` each version. A newer one is refused.

```ts
import { App, Migrate, Plugin, Save } from "arcadekit";
import { Effect } from "effect";

const migrations: Save.Migration[] = [
  {
    from: 1, // takes a save of version 1 to version 2
    migrate: ({ world }) => {
      Migrate.renameComponent(world, "game/Hp", "game/Health");
      Migrate.addField(world, "game/Health", "armor", "i32", 0);
      Migrate.mapField(world, "game/Health", "points", "f32", (hp) => hp / 2);
    },
  },
];

const load = (save: Save.Save, plugins: readonly Plugin.Any[]) =>
  App.load(save, { plugins, version: 2, migrations });
```

A migration is given the save in a plain form that describes itself, `Save.Contents`, so it needs none of the game's old component definitions. Its `world` is what the snapshot lists: components by name with their fields, then tables, sparse sets and singletons, with one column of values per field. Its `queued` and `events` are the waiting actions and events in JSON form.

`Migrate` has the usual changes to a world: `renameComponent`, `removeComponent`, `renameField`, `addField`, `removeField` and `mapField`. Each refuses what isn't there, by name. A singleton is changed the same way, by its name. Entities keep their ids, and two tables that a removed component had kept apart become one.

- What change queries had yet to visit is in `Save.Contents` too, under each component's name. For a component a migration renames, the queries that watch it start over after the load: every entity counts as changed.
- A migration that goes with a changed schema changes the payloads in `queued` and `events` too. A load doesn't check them. A waiting action whose payload no longer fits is refused when its turn comes, and a waiting event's throws when a system first asks for the event.
- A migration makes a new game of an old save, so the log recorded before it no longer replays against it.

## When a load is refused

`Save.decode` and `App.load` fail with `Save.LoadRefused`. Its `problem` says which kind of trouble it is, and its message names the component, the field or the version:

| `problem` | The save |
| --- | --- |
| `"not a save"`, `"not a snapshot"` | Isn't a saved game at all |
| `"truncated"`, `"corrupt"` | Is cut short or damaged |
| `"newer format"` | Was written by a later arcadekit |
| `"newer version"` | Was written by a later version of the game |
| `"no migration"` | Is older, and the game has no migration from its version, or from one on the way |
| `"migration failed"` | Is older, and a migration threw: the message says which, and what it threw |
| `"unknown component"` | Names a component no plugin lists |
| `"component changed"` | Has a component whose fields aren't the game's: the message gives them then and now. After migrations, they didn't bring the save all the way |

## Snapshots on their own

```ts
import { Component, EcsWorld, Field } from "arcadekit";

const Position = Component.define("game/Position", {
  x: Field.f32,
  y: Field.f32,
});

const world = new EcsWorld();
world.spawn(Position.of({ x: 1, y: 2 }));
const bytes = world.snapshot(); // a Uint8Array

const copy = new EcsWorld();
copy.load(bytes, [Position]); // the components it may name
copy.hash() === world.hash(); // true
```

`world.snapshot()` is the whole world as bytes: every table and sparse set, the singletons that have been written, the ids to come, and the state of the random generator. A world that loads them hashes the same and goes on the same: the same order of iteration, the same ids for the next entities, the same random numbers. A save is built on it.

- **It is about as big as the data.** A column of numbers is written as its bytes, so an entity with two `f32` fields takes 20 bytes: 8 of id, 8 of floats and 4 of generation. For four float fields it costs 7 ns per entity to take and 21 ns to load.
- **A component is written under its name**, with the names and kinds of its fields, so a snapshot doesn't depend on the order a program defines its components in. An empty world knows no component, so `load` is given the ones the snapshot may name.
- **A field that isn't a number is saved as [its kind says](components.md).** In a `json` field, text, numbers, booleans, bigints, `null` and `undefined` come back exactly, `-0` and `NaN` too, and an array or an object goes through JSON text. A `schema` or `ref` field is saved in its encoded form, and a `transient` field not at all.
- **`load` fills an empty world**: one that has never held an entity or written a singleton.
- **`world.restore(bytes)` puts a snapshot back into a world in use**, in place of everything it holds, for 16 ns per entity. It is for a snapshot the world took itself. Afterwards the world is what a new one that loaded the snapshot would be. A singleton's value stays the object it was, and `world.random` the generator it was. A view or a `removed` reader that was asked for before throws when it is used, and says to ask again, as a system does every tick. What change queries had yet to visit is forgotten: `world.restoreChanges` takes back what `world.saveChanges` gave.
- **The format is numbered.** This version writes format 3, and reads formats 1 and 2 as well.

Every problem is a `SnapshotError`, whose `problem` is one of the table's above or one of two more: `"world not empty"`, and `"cannot be saved"`, for a field that holds a value with no saved form or a spawn that is queued on a `CommandBuffer` and not applied.

Damaged bytes are refused, not trusted: every count is checked against the bytes that are there before anything is allocated for it, an entity may not be in two rows or in a freed slot, and text has to be text. A damaged number inside a column can't be told from another number, and loads as that.

`readSnapshot` and `writeSnapshot` turn a snapshot into a plain description and back, with no component definitions, for a tool that inspects or edits one.

## Read more

- [`Save`](/reference/arcadekit/Save) and [`Migrate`](/reference/arcadekit/Migrate) in the API reference.
