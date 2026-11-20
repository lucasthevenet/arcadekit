---
"arcadekit": minor
"@arcadekit/three": minor
---

A game lists no components and no events. Defining one is enough: a load finds each component, singleton, state and event a save or a snapshot holds by its name, among the definitions the program has. So a save of a game that forgot to list one can no longer be refused, and a plugin that adds a component can no longer break the loading of every game that uses it. A save that holds a name the program no longer defines is refused with `"unknown component"` or `"unknown event"`, and the message says a migration renames or removes it. Two definitions with one name in one world are refused, as before.

A state moves, its first tick's enter hooks and the transitions asked for included, once a hook waits for it or the world holds it: once a value has been asked for with `set`, or a save brought it. A look at a state, from any stage, changes nothing, so a frame system that reads a state no longer makes a game differ from its replay.

**Breaking**

- The `components` and `events` options of `App.make`, `App.load` and `Plugin.make` are gone, and so are `Plugin.components` and `Plugin.events`. Delete the lists.
- `Transform2d.plugin` and `Transform3d.plugin` are gone, since all they did was list the components. `Three.plugin` no longer includes them.
- `EcsWorld.load(bytes, components)` takes its components only as the ones to prefer over the program's latest definitions, for a tool that reads a snapshot with an older build's. Leave them out otherwise.
- A state that no hook waits for is no longer entered on the first tick of every game: it is entered on the tick after a value is first asked for. A game's hash differs from before until then.
- `EcsWorld.holds(singleton)` is new: whether the world holds a singleton as its own, written or loaded.
