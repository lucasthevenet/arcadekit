---
"arcadekit": minor
---

Scripts are gone. What a game is in the middle of keeps its place in the world, in a component, a singleton or a state, and a system moves it on each tick. So a save, a moment, a replay and the world's hash all see it, and nothing that runs across ticks can be lost by a load, restarted by a rewind, or left out of the log. A system or a handler that waits still throws, and the message says where the work goes instead.

**Breaking**

- `Script`, `app.spawnScript`, the `scripts` of `Plugin.make`, an event's `wait`, `App.make`'s `onScriptFailure` and `App.ScriptFailed` are removed. Keep a script's progress in the world, and move it with a system: a countdown in a singleton for `sleep`, a system that reads an event for `wait`. See "Work that takes many ticks" in the systems guide.
- `app.save()` and `app.capture()` no longer refuse because a script is running.
- `App.App` takes two type parameters, `App<E, HU>`: the services its systems need were there only for scripts.
