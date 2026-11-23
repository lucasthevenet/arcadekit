---
title: "Saving and loading"
description: "A save captures a game between two ticks, and a game loaded from it continues exactly as the saved one would have. Learn how to save, load, and read why a load was refused."
---

A **save** captures a game between two ticks. A game loaded from a save continues exactly as the saved game would have. [Migrating old saves](migrating-saves.md) covers saves that an older version of the game wrote.

## Save and load a game

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

`app.save()` works between two ticks. The save holds the world as a [snapshot](#snapshot-a-world), and the length the action log had. The snapshot holds the game's time, the actions queued for the next tick, the simulation's own among them, the events waiting to be read with each system's place in them, and what change queries haven't visited.

`Save.encode` writes a short header and a little JSON text, then the snapshot unchanged. For 100,000 entities with four float fields, a save is 2.8 MB and takes about 0.7 ms.

`App.make(game, { save })` continues a game from a save. Pass the game the save was made with. No plugin's `setup` runs, since the save already holds what each setup spawned. To start a page from a save, give that app to `Driver.run`. A save holds where the game's random sequence had got to, so `App.make` takes `save` or `seed`, not both.

To return the same app to an earlier moment in the same run, use `Timeline.capture(app)` and `Timeline.rewind(app, moment)`, which work in memory. See [capturing and rewinding](capturing-and-rewinding.md).

## Keep a game savable

- **Keep the names of what a save holds.** A save names every component, singleton, state and event it holds. A load finds each by the definition your program has under that name, with no list to register them in. A save that holds a name your program no longer defines fails to load with `"unknown component"`, or `"store changed"` for an event, and the message names it. Rename or remove the name in a [migration](migrating-saves.md).
- **Keep what the game is in the middle of in the world.** Work that takes [many ticks](systems.md#spread-work-over-many-ticks), such as a countdown or a wave of enemies, keeps its place in a component, a singleton or a state, so a save holds it.
- **Save after a tick.** A game can't be saved while commands are queued but not applied. A tick applies them at its end.

`app.save()` fails with `Save.SaveRefused`, whose message names the problem, when commands are queued, when a field holds a value that can't be saved, or when a queued action or a waiting event has a payload its schema doesn't take.

These aren't saved: `Field.transient` fields, which are `undefined` after a load, and anything kept outside the world, such as a variable of a module.

## Return to the present from a save

```ts sketch
const tail = game.record(save); // from the save's tick to now
const app = yield * Journal.replay(tail, Game);
```

A save records the length the action log had, `save.logLength`. Record what the game played since its last save, and replay only that tail to return to the present. The tail holds the save, so replaying it costs the same however long the game has run.

`app.record(save)` takes a save the app made itself, and throws for one whose tick its log doesn't reach. An app made from a save starts its own log empty, and a recording of it begins at that save.

The [replay](replays.md) checks itself against the tail's checkpoints, so a save that didn't restore the game exactly is caught at the next checkpoint.

## Read why a load was refused

`Save.decode`, and `App.make` with a `save`, fail with `Save.LoadRefused`. Its `problem` identifies the kind of failure, and its message names the component, field or version involved:

| `problem` | The save |
| --- | --- |
| `"not a save"`, `"not a snapshot"` | Isn't a saved game at all |
| `"truncated"`, `"corrupt"` | Is incomplete or damaged |
| `"older format"` | Was written by an earlier version of arcadekit, in a format this one doesn't read |
| `"newer format"` | Was written by a later version of arcadekit |
| `"newer version"` | Was written by a later version of the game |
| `"no migration"` | Is older, and there is no migration from its version, or from a version on the way |
| `"migration failed"` | Is older, and a migration threw. The message says which migration, and what it threw |
| `"unknown component"` | Holds a component this program doesn't define, or no longer by that name |
| `"store changed"` | Holds an event waiting to be read that this program doesn't define, or one in a form its schema no longer takes |
| `"unknown store"` | Holds what the world it was loaded into has no store for, such as queued actions in a world with no app |
| `"component changed"` | Holds a component whose fields differ from the game's after any migrations ran. The message lists both |

## Snapshot a world

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

`world.snapshot()` writes the whole world to bytes: every table and sparse set, the singletons that have been written, the upcoming entity ids, the random generator's state, and in an app's world the actions queued for the next tick and the events waiting to be read. A world that loads the bytes hashes the same and goes on the same way: the same iteration order, the same ids for new entities, the same random numbers. Saves are built on snapshots.

- **Its size is close to the data's.** A numeric column is written as its raw bytes, so an entity with two `f32` fields takes 20 bytes: 8 for the id, 8 for the floats and 4 for the generation. With four float fields, taking a snapshot costs 7 ns per entity and loading it 21 ns.
- **Components are stored by name**, with their field names and types, so a snapshot doesn't depend on the order a program defines its components in. `load` finds each one by its name among the components the program defines, and refuses a snapshot that holds one it doesn't.
- **Non-numeric fields are saved as [their type specifies](components.md#choose-a-field-type).** In a `json` field, strings, numbers, booleans, bigints, `null` and `undefined` round-trip exactly, `-0` and `NaN` included, while arrays and objects go through JSON text. A `schema` or `ref` field is saved in its encoded form, and a `transient` field not at all.
- **`load` fills an empty world**: one that has never held an entity or written a singleton, and holds no queued action or waiting event. A world loads what an app's stores held only when it is that app's. A world made with `new EcsWorld()` refuses a snapshot that holds queued actions or waiting events, with `"unknown store"`.
- **`world.restore(bytes)` replaces everything in a world in use with a snapshot**, for 16 ns per entity. It is meant for a snapshot the world took itself, or one from a world built the same way. Afterwards, the world is what a new world loaded from the snapshot would be. In an app's world, that includes the game's time, the queued actions, the waiting events, and each system's place in them and in what changed. Singleton values keep their object identity, and `world.random` stays the same generator. A view or `removed` reader obtained before throws when used, asking to be obtained again, as a system does every tick. In a world with no app, pending changes for change queries are dropped: `world.restoreChanges` restores what `world.saveChanges` returned.
- **The format is versioned.** This version writes format 4, and also reads formats 1 to 3.

Every failure of `snapshot`, `load` or `restore` is a `SnapshotError`. Its `problem` is one of the table's, except the four only a save has: `"not a save"`, `"newer version"`, `"no migration"` and `"migration failed"`. It can also be one of two more:

- `"world not empty"`, from `load`.
- `"cannot be saved"`, when a field, a queued action or a waiting event holds a value with no saved form, or a spawn is queued on a `CommandBuffer` and not applied.

`load` refuses damaged bytes rather than trusting them. It checks every count against the bytes left before it allocates anything for it, refuses an entity in two rows or in a freed slot, and refuses text that isn't valid. A damaged number inside a column looks like any other number, and loads as that number.

`readSnapshot` and `writeSnapshot` turn a snapshot into a plain description and back, without component definitions, for tools that inspect or edit snapshots.

## Read more

- [`Save`](/reference/arcadekit/Save) and [`Migrate`](/reference/arcadekit/Migrate) in the API reference.
