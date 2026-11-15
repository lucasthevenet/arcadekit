---
"arcadekit": minor
---

The first cut of the revamped arcadekit: an entity component system with Effect 4 around it, for games of any genre.

- A storage core with archetype tables, typed-array columns, opt-in sparse components, cached queries and a command buffer. A world keeps the names of the components it stores, and nothing is shared between worlds.
- Systems as generators, one Effect per tick, on a scheduler the game loop owns, so a tick is deterministic. Scripts are long-running fibers that advance only during ticks; one that fails is logged with its cause, and an app can be told to stop on one.
- Typed events that every system sees exactly once.
- Actions: a handler checks a move against the rules and applies it or refuses it with a typed error. Payloads are validated against a schema, applied actions are logged as JSON-safe data, and the log replays the game.
- Plugins that bundle a feature's systems, handlers, services and setup, and name the plugins they depend on.
- Built-in services keyed under `"arcadekit/"`: `World`, `Time`, `Commands`, `Script`, `Events` and `Action.Actions`.

**Breaking**

Everything. Nothing of the previous version remains: every earlier export is gone, and the package now has one entry, `arcadekit`. A game is written against the new API described in the package's README. There is no Foldkit or Three.js integration yet.
