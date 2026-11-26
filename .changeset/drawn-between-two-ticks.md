---
"arcadekit": minor
"@arcadekit/three": minor
---

A frame system of the game's own draws an entity between its last two ticks with `Transform2d.smooth` or `Transform3d.smooth`, where it had to keep a previous position in the world. `const smooth = yield* Transform2d.smooth` hands out `smooth.position(entity, position, snap)`, `smooth.rotation(entity, rotation)` and `smooth.scale(entity, scale)`, each `Frame.alpha` of the way from where the entity was a tick ago. An entity that moved farther than `snap` in a tick, such as one that was teleported, is drawn where it is. `smooth.positions`, `smooth.rotations` and `smooth.scales` blend a run of rows that `eachChunk` hands out, with no allocation per entity, and `Color.smooth` blends a `Color.Rgb` the same way. Only a frame system can yield one, since each requires `Frame`. The app records an entity's values when a frame first reads it, outside the world, so a game that draws nothing smoothly keeps nothing, and the hash, log and save are the same with it or without.

`Three.instances` and `Three.objects` with `smooth: true` read the same store, so a camera that follows an entity with `Transform3d.smooth` stays on the instance or the object that draws it.

Nothing breaks. One thing a game sees differently: an entity is drawn from where it was whenever any system drew it smoothly in the previous frame, where it was drawn where it is after a frame in which its own system didn't run.
