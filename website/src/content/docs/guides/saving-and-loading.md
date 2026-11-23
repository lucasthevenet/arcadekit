---
title: "Saving and loading"
description: "A save captures a game between two ticks, and a game loaded from it continues exactly as the saved one would have. Learn how to save, load, and migrate old saves."
---

A **save** captures a game between two ticks, and a game loaded from it continues exactly as the saved game would have. This guide covers saving, loading, and migrating old saves.

## Saving

```ts
import {
  App,
  Commands,
  Component,
  Field,
  Plugin,
  Save,
  World,
} from "arcadekit";
import { Effect, Exit } from "effect";

const Position = Component.define("game/Position", { x: Field.f32 });
const Rules = Plugin.make("game/Rules", {
  setup: Effect.gen(function* () {
    (yield* Commands.spawns(Position)).spawn(Position.of({ x: 3 }));
  }),
});
const Game = App.define({ plugins: [Rules] });

const program = Effect.gen(function* () {
  const app = yield* Effect.acquireRelease(
    App.make(Game),
    (made) => made.close
  );
  app.tick(1 / 60);

  const saved = app.save(); // Exit<Save, SaveRefused>
  if (Exit.isFailure(saved)) {
    return;
  }
  const bytes = Save.encode(saved.value); // a Uint8Array, for a file

  const read = Save.decode(bytes); // Exit<Save, LoadRefused>
  if (Exit.isSuccess(read)) {
    const again = yield* Effect.acquireRelease(
      App.make(Game, { save: read.value }),
      (made) => made.close
    );
    const loaded = yield* again.read(World);
    const played = yield* app.read(World);
    loaded.hash() === played.hash(); // true
  }
}).pipe(Effect.scoped);
```

A save is taken between two ticks. It contains the world as a [snapshot](#snapshots), which holds the game's time, the actions queued for the next tick (including the simulation's own) and the events waiting to be read, and beside it each system's position in those events and what change queries haven't visited.

It is essentially the snapshot plus a little text: for 100,000 entities with four float fields, 2.8 MB, taking about 0.7 ms.

`App.make(game, { save })` continues a game from a save. Pass the game the save was made with. No plugin's `setup` runs, since the save already holds its effects. Given to `Driver.run`, it starts a page from one. A save holds where the game's random sequence had reached, so `save` and `seed` can't both be given.

To return to an earlier moment of the same app within the same run, `Timeline.capture(app)` and `Timeline.rewind(app, moment)` work in memory, and encode none of the pending actions and events. See [capturing and rewinding](sessions.md#capturing-and-rewinding).

## Requirements for saving

- **Give each component one name.** A save names every component, singleton, state and event it holds, and a load finds each by the definition your program has under that name. Nothing lists them. A save that holds a name your program no longer defines fails to load and names it, with `"unknown component"`, or `"store changed"` for an event: rename or remove it in a migration.
- **Keep what the game is in the middle of in the world.** Work that takes [many ticks](systems.md#work-that-takes-many-ticks), such as a countdown or a wave of enemies, keeps its place in a component, a singleton or a state, so a save holds it.
- **Save after a tick.** A game can't be saved while commands are queued but not applied. A tick applies them at its end.

When the last requirement isn't met, or a field holds a value that can't be saved, `app.save()` fails with `Save.SaveRefused`, whose message names the problem.

These aren't saved: `Field.transient` fields, which are `undefined` after a load, and anything kept outside the world, such as a variable of a module.

## Saves and the action log

A save records the log's length at the time, `save.logLength`. A game that keeps what it recorded since its last save can return to the present by replaying only that tail, which holds the save and costs the same however long the game has been running:

```ts sketch
const tail = game.record(save); // from the save's tick to now
const app = yield * Journal.replay(tail, Game);
```

`app.record(save)` takes a save the app made itself, and throws for one whose tick its log doesn't reach. An app made from a save starts its own log empty, and a recording of it begins at that save.

The [replay](replays.md) verifies itself against the tail's checkpoints, so a save that didn't restore the game faithfully is caught at the next checkpoint.

## Versions and migrations

A game has a `version`: an integer you increment whenever you change its components or what its saves contain, 0 by default. A save records the version that wrote it. A save of the current version loads as is. An older one is migrated one version at a time, by the migration `from` each version. A newer one is refused.

```ts
import { App, Migrate, Plugin, Save } from "arcadekit";
import { Effect } from "effect";

const migrations: Save.Migration[] = [
  {
    from: 1, // migrates a version 1 save to version 2
    migrate: ({ world }) => {
      Migrate.renameComponent(world, "game/Hp", "game/Health");
      Migrate.addField(world, "game/Health", "armor", "i32", 0);
      Migrate.mapField(
        world,
        "game/Health",
        "points",
        "f32",
        (hp: number) => hp / 2
      );
    },
  },
];

const load = (save: Save.Save, plugins: readonly Plugin.Any[]) =>
  App.make(App.define({ plugins, version: 2, migrations }), { save });
```

A migration receives the save in a plain, self-describing form, `Save.Contents`, so it needs none of the game's old component definitions. Its `world` lists what the snapshot holds: components by name with their fields, then tables, sparse sets and singletons, with one column of values per field. The game's time is one of the world's singletons, `arcadekit/Time`. The world's `stores` hold what the app keeps of the game beside its entities, each as plain data under a name:

| Store | Holds |
| --- | --- |
| `Action.INTAKE` | `{ queued }`: the pending actions, each as `{ name, payload, from? }` with its payload in JSON form |
| `Event.STORE` | One `{ name, waiting, read }` per event with events pending: the events in JSON form, and how many of them each system had read |
| `Save.VISITS` | What change queries haven't visited, one entry per component and kind of change |

`Migrate` covers the common changes to a world: `renameComponent`, `removeComponent`, `renameField`, `addField`, `removeField` and `mapField`. Each fails, by name, when what it targets doesn't exist. `addField` and `mapField` also fail for a value that a field of a number type cannot hold, such as a string, a fraction in an `i32`, or 300 in a `u8`, where the typed array would have stored something else; the compiler refuses a value that is not a number. Singletons are migrated the same way, by name. Entities keep their ids, and two tables that only a removed component kept apart are merged.

- For a component a migration renames, the change queries watching it start over after the load: every entity counts as changed.
- When a migration accompanies a schema change, it must also update the payloads in `world.stores`. A waiting event whose payload its schema no longer takes refuses the save as it is loaded, with `"store changed"`; a queued action whose payload doesn't match is refused when its turn comes, as an `Action.Rejected` event.
- A migration turns an old save into a new game, so the log recorded before it doesn't replay against the migrated save.

## When a load is refused

`Save.decode` and `App.make` with a `save` fail with `Save.LoadRefused`. Its `problem` identifies the kind of failure, and its message names the component, field or version involved:

| `problem` | The save |
| --- | --- |
| `"not a save"`, `"not a snapshot"` | Isn't a saved game at all |
| `"truncated"`, `"corrupt"` | Is incomplete or damaged |
| `"newer format"` | Was written by a later version of arcadekit |
| `"newer version"` | Was written by a later version of the game |
| `"no migration"` | Is older, and there is no migration from its version, or from a version on the way |
| `"migration failed"` | Is older, and a migration threw: the message says which, and what it threw |
| `"unknown component"` | Contains a component this program doesn't define, or no longer by that name |
| `"store changed"` | Holds an event waiting to be read that this program doesn't define, or one in a form its schema no longer takes |
| `"unknown store"` | Has a world that holds what this program's world has no store for: it was loaded into a world of its own, with no app |
| `"component changed"` | Has a component whose fields differ from the game's: the message lists both. After migrations, they didn't bring the save fully up to date |

## Snapshots

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
copy.load(bytes);
copy.hash() === world.hash(); // true
```

`world.snapshot()` serializes the whole world to bytes: every table and sparse set, the singletons that have been written, the upcoming entity ids, the random generator's state, and in an app's world the actions queued for the next tick and the events waiting to be read. A world that loads the bytes hashes the same and continues the same way: the same iteration order, the same ids for new entities, the same random numbers. Saves are built on snapshots.

- **Its size is close to the data's.** A numeric column is written as its raw bytes, so an entity with two `f32` fields takes 20 bytes: 8 for the id, 8 for the floats and 4 for the generation. With four float fields, taking a snapshot costs 7 ns per entity and loading it 21 ns.
- **Components are stored by name**, with their field names and types, so a snapshot doesn't depend on the order a program defines its components in. `load` finds each one by its name among the components the program defines, and refuses a snapshot that holds one it doesn't.
- **Non-numeric fields are saved as [their type specifies](components.md#field-types).** In a `json` field, strings, numbers, booleans, bigints, `null` and `undefined` round-trip exactly, `-0` and `NaN` included, while arrays and objects go through JSON text. A `schema` or `ref` field is saved in its encoded form, and a `transient` field not at all.
- **`load` fills an empty world**: one that has never held an entity or written a singleton, and holds no queued action or waiting event. A world loads what an app's stores held only when it is that app's: a world made with `new EcsWorld()` refuses a snapshot that holds queued actions or waiting events, with `"unknown store"`.
- **`world.restore(bytes)` replaces everything in a world in use with a snapshot**, for 16 ns per entity. It is for snapshots the world took itself. Afterwards, the world is what a new world loaded from the snapshot would be: in an app's world, with the game's time, the queued actions, the waiting events and each system's place in them and in what changed, as the snapshot has them. Singleton values keep their object identity, and `world.random` stays the same generator. A view or `removed` reader obtained before throws when used, asking to be obtained again, as a system does every tick. In a world with no app, pending changes for change queries are dropped: `world.restoreChanges` restores what `world.saveChanges` returned.
- **The format is versioned.** This version writes format 4, and also reads formats 1 to 3.

Every failure is a `SnapshotError`, whose `problem` is one of the values in the table above, or one of two more: `"world not empty"`, and `"cannot be saved"`, for a field, a queued action or a waiting event holding a value with no saved form, or a spawn queued on a `CommandBuffer` and not applied.

Damaged bytes are refused, not trusted: every count is checked against the available bytes before anything is allocated for it, an entity can't occupy two rows or a freed slot, and text must be valid text. A damaged number inside a column is indistinguishable from any other number, and loads as that number.

`readSnapshot` and `writeSnapshot` convert a snapshot to a plain description and back, without component definitions, for tools that inspect or edit snapshots.

## Read more

- [`Save`](/reference/arcadekit/Save) and [`Migrate`](/reference/arcadekit/Migrate) in the API reference.
