---
"@arcadekit/three": minor
---

The check that a kind's `of` gives its entities the `Position` of its `transform` counts a component that is that `Position`, not only one that requires it. A kind of `of: Transform3d.Position`, or of `[Heavy, Transform3d.Position]`, now compiles. And it refuses an `of` typed as a plain `ComponentDef` or `readonly ComponentDef[]`, whose requirements the compiler only knows as `string`. Such a kind compiled with no check, and an entity spawned with that component alone was never drawn, with no error.

**Breaking**

- A kind or a helper whose `of` is typed as `ComponentDef` no longer compiles. Type it as the component it is, as `typeof Rock`, or take it as a type parameter with `Three.TransformOf`:

```ts
const crowd = <const O extends Three.Which["of"]>(
  name: string,
  of: O,
  transform: Three.TransformOf<O>
) => Three.instances(name, { of, transform, geometry, material });
```
