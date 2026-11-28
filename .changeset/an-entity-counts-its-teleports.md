---
"arcadekit": minor
"@arcadekit/three": patch
---

An entity counts its own teleports, and everything that draws it between two ticks draws it where it landed. `Transform2d.Teleports` and `Transform3d.Teleports` hold a `count`, which the tick that teleports an entity adds one to. Every reader of `Transform2d.smooth` and `Transform3d.smooth`, and every kind of `@arcadekit/three` drawn with `smooth: true`, then draws the entity at its position, rotation and scale until the next tick, with no `snap` given, so two readers can no longer draw one teleport two ways. The count is a component of the game: a rewind takes a teleport back, and a peer that hears of one late draws the entity where it landed. An entity without it costs nothing.

**Breaking**: `Transform2d.smooth` and `Transform3d.smooth` require `World` beside `Frame` and `Time`. A frame system has all three, so a game that yields them there changes nothing; one that provides them by hand provides `World` too. `snap` stays, for a long move the game doesn't count as a teleport.
