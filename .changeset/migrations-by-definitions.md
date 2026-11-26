---
"arcadekit": minor
---

A save is migrated in one module, `Migrate`, by definitions: a step names what the game has now by its definition, and what it no longer has by its old name, and carries the events waiting to be read, the actions queued and the states with their scoped entities, as it does components.

```ts
const migrations = [
  Migrate.step(1, (save) => {
    save.renameComponent("game/Hp", Health);
    save.addField(Health, "max", 10); // a field of Health's, of its kind
    save.renameEvent("game/Hit", Struck);
    save.mapPayloads(Move, (payload) => ({
      ...(payload as Move0),
      run: false,
    }));
    save.renameStateValue(Phase, "play", "playing"); // its scope tag with it
  }),
];
```

`Migrate.Contents` has `renameComponent`, `removeComponent`, `renameField`, `addField`, `removeField`, `mapField`, `renameEvent`, `removeEvent`, `renameAction`, `removeAction`, `mapPayloads`, `renameState` and `renameStateValue`. A field the definition doesn't have doesn't compile. A load refused for a name a save holds says which of them to use.

**Breaking**

- `Save.Migration`, `Save.migrate` and `Save.Contents` are `Migrate.Migration`, `Migrate.migrate` and `Migrate.Contents`, and `{ from, migrate: (contents) => ... }` is `Migrate.step(from, (save) => ...)`.
- The functions of `Migrate` that took the save's world and names are the methods of the save a step is given, which take definitions: `Migrate.renameComponent(world, "game/Hp", "game/Health")` is `save.renameComponent("game/Hp", Health)`, and `Migrate.addField(world, "game/Health", "armor", "i32", 0, "points")` is `save.addField(Health, "armor", 0)`, of the kind and at the place `Health` gives it.
- `Save.VISITS` is gone: `renameComponent` renames what change queries had yet to visit, and nothing else of a game names it.
