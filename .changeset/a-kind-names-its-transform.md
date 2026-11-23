---
"@arcadekit/three": minor
---

A kind of `Three.instances` or `Three.objects` names the transform it draws from, `transform: Transform3d` or `transform: Transform2d`, and reads nothing of the other. An entity with both a `Transform3d.Position` and a `Transform2d.Position` used to be drawn from the 3D one, its `Transform2d` rotation and scale left unread, with no error. It is now drawn by a kind of each, each from its own.

**Breaking**

- `transform` is required, and a kind without it doesn't compile. A kind of a 3D game adds `transform: Transform3d`, and one of a flat game `transform: Transform2d`.
- A kind draws only the entities its transform places. A kind that drew flat and 3D entities together is now two kinds, one of each:

```ts
const Rocks = Three.instances("game/Rocks", {
  of: Rock,
  transform: Transform3d,
  geometry,
  material,
});
const FlatRocks = Three.instances("game/FlatRocks", {
  of: Rock,
  transform: Transform2d,
  geometry,
  material,
});
```
