---
"@arcadekit/three": patch
---

`@arcadekit/three/Three` is written as files of its own in `src/three/`, behind the same entry. Each public file declares the exports it gives, with their doc comments: the scene, the renderer, which entities a system draws, the textures and loading managers made of assets, instances and objects. What they run on is in `src/three/internal/`. The built package has a file for each in `dist/three/`.

Nothing breaks: the entry, and what it gives, are the same.
