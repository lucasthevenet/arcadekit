---
"arcadekit": minor
---

An app loads a save in place, a save is kept in a slot, and a setting is kept outside the world.

```ts
Effect.gen(function* () {
  yield* Save.write("slot2", yield* app.save()); // kept in Save.Store
  const saved = yield* Save.read("slot2"); // an Option
  if (Option.isSome(saved)) {
    yield* app.load(saved.value); // the same app, its layers, stages and driver
  }

  const Volume = Setting.define("game/Volume", Schema.Number, 1);
  yield* Setting.set(Volume, 0.5); // kept in Setting.Store, through a reload
});
```

- `app.load(save)` puts the game a save holds into the app that runs, as `App.make(game, { save })` would make it, and fails with `Save.LoadRefused`, leaving the app as it was, for a save the game can't load. Its log starts over, and `Timeline.rewind` refuses a moment captured before the load.
- `Save.Store`, provided with `Save.layer(store)`, keeps saves by slot: `Save.write` and `Save.read`, which fail with `Save.StoreFailed`. `Browser.saves(name)` keeps them in a page's local storage, and `Save.makeMemory()` in memory for a test.
- The new module `arcadekit/Setting`: `Setting.define(key, schema, initial)`, read with `yield*` in the frame and input stages and never in a tick, and `Setting.set`, which fails with `Setting.Invalid` or `Setting.StoreFailed`. `Setting.Store` keeps them, with `Setting.layer(store)`, `Browser.settings(name)` and `Setting.makeMemory()`.
- The guide to snapshots is a page of its own, and settings have one.

**Breaking**

- `App.Steered`, the app a session steps, has no `load`.
