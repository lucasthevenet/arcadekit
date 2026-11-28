---
"arcadekit": minor
---

A game that spawns or adds a `Timer.Lifetime` and leaves out `Timer.plugin` no longer compiles: `App.make` requires `Plugin.Installed<"arcadekit/Timer">`. Before, it ran, and the entity was never despawned. Every plugin provides `Plugin.Installed` of its own name, and `Plugin.KeptBy` marks a component that only one plugin acts on, so that `Commands.spawns` asks for that plugin.

**Breaking**

- A game whose commands name `Timer.Lifetime` in `Commands.spawns` lists `Timer.plugin` among its plugins, itself or through one of them.
- `Plugin.ProvidedOf` of a plugin also holds `Plugin.Installed` of its name, unless the compiler knows that name only as `string`.
