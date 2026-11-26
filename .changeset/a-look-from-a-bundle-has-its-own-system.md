---
"@arcadekit/three": minor
---

A kind whose look or objects are built from a bundle is made with `Three.instancesFrom` or `Three.objectsFrom`, and `Three.instances` and `Three.objects` take only a look that already exists. Each function has one signature. An `of` that requires neither `Position` now fails with the whole reason as the error of the call, for `Transform3d` and `Transform2d` alike. Before, the compiler reported "No overload matches this call", cut the reason short, and ended on a mismatch between the two transform modules.

**Breaking**

- `Three.instances(name, { from, look, … })` is now `Three.instancesFrom(name, { from, look, … })`, and `Three.objects(name, { from, make, … })` is now `Three.objectsFrom(name, { from, make, … })`. The options are the same. `Instances.instancesFrom` and `Objects.objectsFrom` are the same functions in their own modules.
- `Three.Which` no longer has `transform`. Each function still takes `transform`, typed as `Three.TransformOf` of its `of`. Code that read `Three.Which["transform"]` writes `typeof Transform3d | typeof Transform2d`.
- `Three.TransformOf<O>` for an `of` that requires neither `Position` is now `{ readonly Position: { readonly name: <reason> } }`, without the two transform modules in it.
