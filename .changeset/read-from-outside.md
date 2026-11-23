---
"arcadekit": minor
---

Code outside a game reads it with `app.read(effect)` and changes it with an action alone. `app.read` runs an effect that requires `World` and `Time` and nothing else, so a query that only reads, a singleton and a state's value are read the same way, and an effect that requires `Commands`, `World.writes`, a query that writes or watches, an event, `State.sets` or `Singleton.writes` doesn't compile. Everything that changes a game from outside is then in its log, and a replay reproduces it.

**Breaking**

- `app.world`, `app.commands`, `app.events` and `app.dispatcher` are gone from `App.Any`, `App.App` and `App.Steered`.
- Read the world with `const world = yield* app.read(World)`: it has `get`, `has`, `isAlive`, `sources`, `singleton`, `holds`, `entityCount` and `hash`. It stays current, so read it once and keep it.
- `app.world.view(query)` is `yield* app.read(query)`, for a query with no `Query.writes`, `Query.changed` or `Query.added`. `app.world.singleton(Score)` is `yield* app.read(Score)`.
- What a game starts with is spawned by a plugin's `setup`, which a replay runs too. `app.world.spawn`, `set`, `add`, `remove` and `despawn` between ticks are an action whose handler makes the change, issued with `app.enqueue` or `app.dispatch`.
- `Timeline.Game` is `Pick<App.Any, "phase" | "time">`. `Timeline.capture` and `Timeline.rewind` take an app that `App.make` made, and throw for anything else.
