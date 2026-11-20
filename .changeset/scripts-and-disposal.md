---
"arcadekit": minor
"@arcadekit/three": minor
---

A save and a moment no longer leave a running script behind with no error, and `@arcadekit/three` disposes of the geometries and materials of `Three.instances` and `Three.objects` once no system draws with them.

**Breaking**

- `app.capture()` fails with `Save.SaveRefused` while a script is running, and a rewind no longer starts a plugin's scripts again. A rollback session stops with that error on a game whose script is running: do what the script did with systems and states.
- `app.save()` fails with `Save.SaveRefused` while a script started with `app.spawnScript` or `Script.spawn` is running. Save once it has ended. A plugin's `scripts` still start again after a load.
- `@arcadekit/three` disposes of the geometry and material given to `Three.instances` or returned by `look`, and of the geometries and materials of what `make` of `Three.objects` built. Drop a `free` that only disposed of them. One that disposes of them too still works.
