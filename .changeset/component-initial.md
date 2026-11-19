---
"arcadekit": minor
---

A component can say what it is when it is added or spawned bare, with `Component.define(name, fields, { initial })`, where it was always all zeros. `Transform2d.Scale` and `Transform3d.Scale` are 1 along each axis when added bare, where a bare one was all zeros and drawn as nothing.

**Breaking**

- A bare `Transform2d.Scale` or `Transform3d.Scale` is 1 along each axis. A game that added one bare and relied on its zeros gives it `Scale.of({ x: 0, y: 0 })`.
- `ComponentDef` has an `initial` property, undefined unless the component gives one.
