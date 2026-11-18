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

A save holds the world as a snapshot, the game's time, the actions waiting for the next tick, the events waiting to be read and how far each system had read them, and what change queries had yet to visit.

`App.load` takes the plugins and options the game was made with. No plugin's `setup` runs: the save holds what setup did. `App.run` takes a `save` too, to start a page from one.

## What a game has to do

- **List its components.** A world knows a component by its name, so every component, singleton and state a save names has to be in some plugin's `components`. A load that meets one that isn't fails and names it.
- **Keep scripts' progress in the world.** A save can't hold a script in mid-flight. A plugin's `scripts` start again from their beginning after a load, so a script picks up from what it finds in the world.
- **Give what waits a schema.** An action or event that is waiting is saved in its JSON form, so one defined with no schema can't be. `app.save()` fails with `Save.SaveRefused` and says what is in the way.

What isn't saved: a `Field.transient` field, which is undefined after a load, and what a service of the game's own holds.

## A save is a snapshot plus the log since

The save says how long the log was, `save.logLength`. A game that keeps its last save and the actions logged after it can come back to the present by loading the save and replaying only that tail, which costs the same however long the game has run:

```ts sketch
const app = yield * App.load(save, { plugins: [Rules] });
App.replay(app, log.slice(save.logLength), { delta: 1 / 60, ticks });
```

## Versions and migrations

A game has a `version`, a whole number it raises when it changes its components or what its saves hold. A save records the version that wrote it. An older save is brought up one version at a time; a newer one is refused.

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

A migration is given the save in a plain form that describes itself, so it needs none of the game's old component definitions. `Migrate` has the usual changes: `renameComponent`, `removeComponent`, `renameField`, `addField`, `removeField` and `mapField`. Each refuses what isn't there, by name.

Every refusal is a `Save.LoadRefused` that says why: a newer version, a missing migration, a migration that threw, or a component that still doesn't match.

## Snapshots on their own

`world.snapshot()` is the whole world as bytes, and a new world that loads them hashes the same and goes on the same. A save is built on it. `readSnapshot` and `writeSnapshot` turn one into a plain description and back, for a tool that inspects or edits one.

## Read more

- [`Save`](/reference/arcadekit/Save) and [`Migrate`](/reference/arcadekit/Migrate) in the API reference.
