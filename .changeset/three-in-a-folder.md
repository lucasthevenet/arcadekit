---
"@arcadekit/three": patch
---

`@arcadekit/three/Three` is written as files of its own in `src/three/`, behind the same entry: the scene, the renderer, which entities a system draws, their interpolation between ticks, what is made of assets, instances and objects. The built package has a file for each in `dist/three/`.

Nothing breaks: the entry, and what it gives, are the same.
