---
"arcadekit": minor
---

`arcadekit/Vec2` and `arcadekit/Overlap` are new entries. `Vec2.length`, `Vec2.distance`, `Vec2.normalize` and `Vec2.clampLength` work on two numbers and write into a row or an object that is reused. `Overlap.circles`, `Overlap.boxes` and `Overlap.circleBox` test two shapes, and `Overlap.pairs` calls back for every pair of entities of two queries whose `Overlap.Circle` or `Overlap.Box` touch, beside `Transform2d.Position`, and despawns what the callback returns, so an entity it despawns is in no later pair of the call. None of them allocates in its loop. Nothing breaks.
