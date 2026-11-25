---
"@arcadekit/three": minor
---

`Three.instances` and `Three.objects` type `transform` as `Three.TransformOf<O>` of the kind's `of`: the module whose `Position` `of` requires, whichever component of its type it is. A helper that took `of` and `transform` as two unions compiled a call that paired a 3D marker with `Transform2d`, and its entities, spawned with the marker alone, were never drawn, with no error. The same helper, written with `TransformOf`, refuses such a call.

**Breaking**

- `Three.Drawn` is removed. Its check is `Three.TransformOf`, and a mismatched kind's error is now on `transform`, not on `of`.
- A helper that types `of` and `transform` as two unions no longer compiles. It takes `of` as a type parameter, and `transform` as `TransformOf` of it:

```ts
const crowd = <const O extends Three.Which["of"]>(
  name: string,
  of: O,
  transform: Three.TransformOf<O>
) => Three.instances(name, { of, transform, geometry, material });

crowd("game/Rocks", Rock, Transform3d);
crowd("game/Lifted", Rock, Transform2d); // doesn't compile
```

- The type parameter `T` of the transform is gone from both functions' signatures.
