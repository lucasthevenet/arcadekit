---
"arcadekit": minor
---

The world a system, a handler, a setup or a plugin's layer is handed, and the one `app.read(World)` gives, is one object per app of its own, which reads and sets the world behind it. No check of its class reaches `spawn`, `despawn` or `restore` through it.

**Breaking**

- `yield* World` is no longer an `EcsWorld`, so `instanceof EcsWorld` is false. Change the set of entities with `Commands`.
- `whole` is no export of `arcadekit/Services`.
