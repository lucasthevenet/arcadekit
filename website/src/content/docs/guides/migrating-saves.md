---
title: "Migrating old saves"
description: "A game's version says which saves it loads as they are. A migration turns a save an older version wrote into one the current version loads."
---

A **migration** turns a save written by an older version of your game into a save the current version loads. [Saving and loading](saving-and-loading.md) covers saves themselves.

## Version a game and migrate its saves

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

`App.define` takes the game's `version`, an integer that defaults to 0. Increment it whenever you change the game's components or what its saves hold. A save records the version that wrote it:

- A save of the current version loads as it is.
- An older save is migrated one version at a time, by the migration `from` each version on the way.
- A newer save is refused with `"newer version"`.

`Migrate.renameComponent` renames the component in the save's tables, sparse sets and singletons, but not its entries under `Save.VISITS`, what change queries had yet to visit. After the load, every change query on the renamed component starts over. Its first visit covers every entity with the component, so an `added` query sees all of them as added.

## Read a save's contents

A migration receives the save in a plain, self-describing form, `Save.Contents`, so it needs none of the game's old component definitions. Its `world` lists what the snapshot holds: components by name with their fields, then tables, sparse sets and singletons, with one column of values per field. The game's time is one of the world's singletons, `arcadekit/Time`. The world's `stores` hold what the app keeps of the game beside its entities, each as plain data under a name:

| Store | Holds |
| --- | --- |
| `Action.INTAKE` | `{ queued }`: the pending actions, each as `{ name, payload, from? }` with its payload in JSON form |
| `Event.STORE` | One `{ name, waiting, read }` per event with events pending: the events in JSON form, and how many of them each system had read |
| `Save.VISITS` | What change queries haven't visited, one entry per component and kind of change |

## Change a save's world with `Migrate`

`Migrate` makes the common changes to a world: `renameComponent`, `removeComponent`, `renameField`, `addField`, `removeField` and `mapField`.

- Each throws, naming what it targets, when that doesn't exist. A migration that throws refuses the save with `"migration failed"`.
- `addField` and `mapField` also throw for a value that a number field can't hold, such as a string, a fraction in an `i32`, or 300 in a `u8`, which the typed array would store as something else. The compiler refuses a value that isn't a number for such a field.
- Singletons are migrated the same way, by name.
- Entities keep their ids, and two tables that only a removed component kept apart are merged.
- When the schema of an event or an action changes, update its payloads in `world.stores` too. A waiting event whose payload its schema no longer takes refuses the save at load, with `"store changed"`. A queued action whose payload doesn't match is refused when its turn comes, as an `Action.Rejected` event.
- A migration turns an old save into a new game, so the log recorded before it doesn't replay against the migrated save.

A save the migrations can't bring up to date is refused with `"no migration"`, `"migration failed"` or `"component changed"`, and a save of a newer version with `"newer version"`. [Read why a load was refused](saving-and-loading.md#read-why-a-load-was-refused) lists every reason.

## Read more

- [`Save`](/reference/arcadekit/Save) and [`Migrate`](/reference/arcadekit/Migrate) in the API reference.
