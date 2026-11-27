---
title: "Migrating old saves"
description: "A game's version says which saves it loads as they are. A migration turns a save an older version wrote into one the current version loads, naming what the game has now by its definition."
---

A **migration** turns a save written by an older version of your game into a save the current version loads. [Saving and loading](saving-and-loading.md) covers saves themselves.

## Version a game and migrate its saves

```ts
import {
  Action,
  App,
  Component,
  Event,
  Field,
  Migrate,
  Plugin,
  Save,
  State,
} from "arcadekit";
import { Schema } from "effect";

// The game as it is now, version 2.
const Health = Component.define("game/Health", {
  armor: Field.i32,
  points: Field.f32,
});
const Struck = Event.define("game/Struck", Schema.Struct({ by: Schema.Int }));
const Move = Action.define(
  "game/Move",
  Schema.Struct({ dx: Schema.Int, run: Schema.Boolean })
);
const Phase = State.define("game/Phase", ["menu", "playing", "over"]);

const migrations = [
  Migrate.step(1, (save) => {
    // From version 1 to version 2.
    save.renameComponent("game/Hp", Health);
    save.addField(Health, "armor", 0);
    save.mapField(Health, "points", (hp: number) => hp / 2);
    save.renameEvent("game/Hit", Struck);
    save.mapPayloads(Move, (payload) => ({
      ...(payload as { dx: number }),
      run: false,
    }));
    save.renameStateValue(Phase, "play", "playing");
  }),
];

const Game = Plugin.make("game/Game", {});
const Duel = App.define({ plugins: [Game], version: 2, migrations });

const load = (save: Save.Save) => App.make(Duel, { save });
```

`App.define` takes the game's `version`, an integer that defaults to 0. Increment it whenever you change the game's components or what its saves hold. A save records the version that wrote it:

- A save of the current version loads as it is.
- An older save is migrated one version at a time, by the step `from` each version on the way, `Migrate.step(from, edit)`.
- A newer save is refused with `"newer version"`.

Whatever the version, a load compares each component in the save with the game's: its storage, and its fields' names, order and kinds. A save that differs is refused with `"component changed"`, unless a migration makes it match. A change that keeps all of those is not seen. If a field now holds metres where it held pixels, or a `json` field holds objects of another shape, a save of the same version loads with no error and the game reads the old values as new ones. Increment the version with each such change, and convert the values in its migration with `mapField`.

## Change a save

A step is given the save as `Migrate.Contents`, which changes it in place. Each change names what the game has now by its definition, and what it no longer has by its old name:

| Change | Does |
| --- | --- |
| `renameComponent(old, Def)` | Renames a component or a singleton to its definition's name, with what its change queries had yet to visit, so they go on from where they were |
| `removeComponent(old)` | Removes a component and every entity's values of it. The entities remain |
| `renameField(Def, old, field)` | Renames a field to one of the definition's |
| `addField(Def, field, value)` | Adds a field of the definition's, of its kind and at its place, with one value for every entity |
| `removeField(Def, old)` | Removes a field the definition no longer has |
| `mapField(Def, field, map)` | Changes a field to the definition's kind, each value computed from the old one |
| `renameEvent(old, Event)`, `removeEvent(old)` | Renames, or removes, the events of a name that are waiting to be read |
| `renameAction(old, Action)`, `removeAction(old)` | Renames, or removes, the actions of a name queued for the next tick |
| `mapPayloads(Event or Action, map)` | Computes anew the payload of each waiting event or queued action of the definition, from the old one in its JSON form |
| `renameState(old, State)` | Renames a state, with the tags of the entities scoped to its values |
| `renameStateValue(State, old, value)` | Renames a value of a state: where the state is, where it is going, and the tag of the entities scoped to it |

- A field the definition doesn't have doesn't compile, nor does a value of the wrong type for one, nor a state's value it doesn't have.
- Each change throws, naming what it was asked for and what the save holds, when the save doesn't hold it. A migration that throws refuses the save with `"migration failed"`.
- A field of a number type also throws for a value it can't hold, such as a fraction in an `i32`, or 300 in a `u8`, which the typed array would store as something else. An entity is kept as its id, a `Field.bool` as 1 or 0, and a `ref` field encoded by its codec.
- Entities keep their ids, and two tables that only a removed component kept apart are merged.
- A state's value that was renamed in the game and not in the save leaves a tag of a value the state no longer has, and the load is refused with `"unknown component"`. `renameStateValue` renames the tag with the value.
- A migration turns an old save into a new game, so the log recorded before it doesn't replay against the migrated save.

A save the migrations can't bring up to date is refused with `"no migration"`, `"migration failed"` or `"component changed"`, and a save of a newer version with `"newer version"`. [Read why a load was refused](saving-and-loading.md#read-why-a-load-was-refused) lists every reason.

## Read what a save holds

`save.world` is the save in a plain form that describes itself, for what the changes don't do. It lists components by name with their fields, then tables, sparse sets and singletons, with one column of values per field. The game's time is one of the world's singletons, `arcadekit/Time`. Its `stores` hold what the app keeps of the game beside its entities, each as plain data under a name: the actions queued for the next tick under `Action.INTAKE`, as `{ queued }`, and the events waiting to be read under `Event.STORE`, as one `{ name, waiting, read }` for each event. `yield* Migrate.migrate(save, version, migrations)` runs a game's migrations on a save outside an app, and a tool that edits a snapshot makes its own with `new Migrate.Contents(readSnapshot(bytes))`.

## Read more

- [`Migrate`](/reference/arcadekit/Migrate) and [`Save`](/reference/arcadekit/Save) in the API reference.
