---
"arcadekit": minor
"@arcadekit/three": minor
---

A plugin can be stopped and started while the game runs, with `app.stop(plugin)` and `app.start(plugin)`, and `app.running` lists the plugins running now. A stopped plugin runs none of its systems or hooks, refuses its actions with `Plugin.Stopped`, and closes its scope: its systems, handlers, setup and scripts get that scope as `Scope.Scope`, so its scripts are interrupted and what they acquired is released. Stopping and starting are logged, replayed and sent to a session's peers like actions, and a save and a moment hold which plugins are stopped. In `@arcadekit/three`, what a plugin draws leaves the scene when it stops, and the geometries and materials of `Three.instances` and `Three.objects` are disposed of once no system draws with them.

**Breaking**

- `app.capture()` fails with `Save.SaveRefused` while a script is running, and a rewind no longer starts a plugin's scripts again. A rollback session stops with that error on a game whose script is running: do what the script did with systems and states.
- `app.save()` fails with `Save.SaveRefused` while a script started with `app.spawnScript` or `Script.spawn` is running. Save once it has ended. A plugin's `scripts` still start again after a load.
- `Script.spawn` from a plugin's system, handler or script forks into the plugin's scope, so stopping the plugin interrupts the script.
- `BuiltIn` includes `Scope.Scope`. A type that listed what a system of `@arcadekit/three` requires adds `Scope.Scope`, or uses `BuiltIn`.
- `@arcadekit/three` disposes of the geometry and material given to `Three.instances` or returned by `look`, and of the geometries and materials of what `make` of `Three.objects` built. Drop a `free` that only disposed of them. One that disposes of them too still works.
