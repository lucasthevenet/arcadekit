---
"arcadekit": minor
---

The first cut of the revamped arcadekit: an entity component system with Effect 4 around it, for games of any genre.

- A storage core with archetype tables, typed-array columns, opt-in sparse components, cached queries and a command buffer. A world keeps the names of the components it stores, and nothing is shared between worlds.
- Systems as generators, one Effect per tick, on a scheduler the game loop owns, so a tick is deterministic. Scripts are long-running fibers that advance only during ticks; one that fails is logged with its cause, and an app can be told to stop on one.
- Typed events that every system sees exactly once.
- Actions: a handler checks a move against the rules and applies it or refuses it with a typed error. A handler runs in a transaction of the world (`world.begin`, `commit`, `rollback`), so a refusal at any point leaves nothing behind: its writes, random draws, queued commands, events and enqueued actions are taken back. Payloads are validated against a schema. What comes from outside the simulation is logged as JSON-safe data, in the order it arrives, and the log replays the game; what a system, a script or a handler issues with `Actions` is not logged, because a replay's own simulation issues it again. The log carries a checkpoint of the world's hash every so many ticks (`checkpointEvery`, and `app.checkpoint()`), and a replay stops with `App.ReplayDiverged` at the first that does not match.
- Plugins that bundle a feature's systems, handlers, services and setup, and name the plugins they depend on.
- Seeded randomness: `Random` gives `next`, `int`, `pick` and `shuffle` from a generator whose state is part of the world. `App.make({ seed })` seeds it, the same seed gives the same numbers on every machine, and Effect's own `Random` is seeded from it inside an app.
- `world.hash()`: one number for everything in a world that a simulation can tell apart, the same on every machine, which changes whenever one field of one entity does.
- Built-in services keyed under `"arcadekit/"`: `World`, `Time`, `Commands`, `Script`, `Events`, `Random` and `Action.Actions`.

**Breaking**

Everything. Nothing of the previous version remains: every earlier export is gone, and the package now has one entry, `arcadekit`. A game is written against the new API described in the package's README. There is no Foldkit or Three.js integration yet.
