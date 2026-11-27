---
"arcadekit": minor
---

`commands.despawning(entity)` returns whether an entity is queued to despawn, and so does `CommandBuffer.despawning` of `arcadekit/ecs`. `Overlap.pairs` asks it before each pair, so an entity queued to despawn takes part in no later pair of the call, however it was queued: by what the callback returns, by `commands.despawn` in the callback, or before the call. A bullet that the callback despawns itself hits once.

**Breaking**

- The commands that `Overlap.pairs` takes have a `despawning` beside `despawn`. The app's `Commands` and a `CommandBuffer` have both. A stand-in of a game's own adds `despawning: () => false`.
- A class or object that implements `Spawning` itself adds `despawning`.
