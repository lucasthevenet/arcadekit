---
"arcadekit": minor
---

The first cut of the revamped arcadekit: an entity component system with Effect 4 around it, for games of any genre.

- A storage core with archetype tables, typed-array columns, opt-in sparse components, cached queries and a command buffer. A world keeps the names of the components it stores, and nothing is shared between worlds.
- Change queries: `Query.changed` and `Query.added` visit only the entities that had a component written, or gained one, since the system last looked, and `Query.removed` gives the ones that lost one. Every system sees every change once, a visit costs next to nothing when nothing changed, and what a query has yet to visit is saved with a game.
- Singletons: `Singleton.define` declares data the world holds one of, such as whose turn it is, and `yield*` gives its value to read and write. It is saved with the world and counted in its hash, and a refused action's writes to it are taken back.
- Relations: `Component.relation` declares a component that points at another entity and says what that entity's despawn does to whoever points at it: despawned with it, like a parent's children, or left without the relation. Nothing is left pointing at an entity that is gone, and `world.sources` gives who points at one.
- States and run conditions: `State.define` declares the few named values a game can be in, `System.runIf(State.is(...))` runs a system only in some of them, and `State.onEnter` and `State.onExit` make a system a hook that runs once on the way in or out. A state is a singleton, so it is saved and replayed.
- Systems as generators, one Effect per tick, on a scheduler the game loop owns, so a tick is deterministic. Scripts are long-running fibers that advance only during ticks; one that fails is logged with its cause, and an app can be told to stop on one.
- Typed events that every system sees exactly once. `Event.define` takes a schema, and `Event.encode` and `Event.decode` write an event as JSON and read it back.
- Actions: a handler checks a move against the rules and applies it or refuses it with a typed error. A handler runs in a transaction of the world (`world.begin`, `commit`, `rollback`), so a refusal at any point leaves nothing behind: its writes, random draws, queued commands, events and enqueued actions are taken back. Payloads are validated against a schema. What comes from outside the simulation is logged as JSON-safe data, in the order it arrives, and the log replays the game; what a system, a script or a handler issues with `Actions` is not logged, because a replay's own simulation issues it again. The log carries a checkpoint of the world's hash every so many ticks (`checkpointEvery`, and `app.checkpoint()`), and a replay stops with `App.ReplayDiverged` at the first that does not match.
- Plugins that bundle a feature's systems, handlers, services and setup, and name the plugins they depend on.
- Seeded randomness: `Random` gives `next`, `int`, `pick` and `shuffle` from a generator whose state is part of the world. `App.make({ seed })` seeds it, the same seed gives the same numbers on every machine, and Effect's own `Random` is seeded from it inside an app.
- Saving and loading: `app.save()` gives the world, the time, the waiting actions and the waiting events; `Save.encode` and `Save.decode` turn a save into bytes and back; `App.load` brings the game back where it was. A plugin lists its `components` and its `scripts`, which start again after a load.
- Versions and migrations: a save records the game's `version`; `App.load` brings an older save up to date with the game's `migrations`, which edit a self-describing form of the save with `Migrate`, and refuses a newer or unmigratable one with the reason.
- Fields that are not numbers say what saving does with them: `Field.json` (plain data), `Field.schema` (any value an Effect schema describes), `Field.ref` with a codec of your own, and `Field.transient` (not saved, not hashed). The hash covers exactly what a snapshot saves.
- `world.snapshot()` and `world.load()`: the whole world as compact bytes, and back into an empty world that hashes the same and goes on the same. A problem is a `SnapshotError` that says which kind and names the component.
- `world.hash()`: one number for everything in a world that a simulation can tell apart, the same on every machine, which changes whenever one field of one entity does.
- Built-in services keyed under `"arcadekit/"`: `World`, `Time`, `Commands`, `Script`, `Events`, `Random` and `Action.Actions`.

**Breaking**

Everything. Nothing of the previous version remains: every earlier export is gone, and the package now has one entry, `arcadekit`. A game is written against the new API described in the package's README. There is no Foldkit or Three.js integration yet.
