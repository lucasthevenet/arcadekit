---
"arcadekit": minor
"@arcadekit/three": minor
---

The packages are built by the TypeScript compiler, one file of `dist/` for each source file, and nothing is bundled. A module that an entry gathers is that module. `import { Transform3d } from "arcadekit"` is the module `arcadekit/Transform3d`, at run time and in its type, so it can be passed as `transform` to `Three.instances` and `Three.objects`. The same holds for each module of `arcadekit`, `arcadekit/net`, `arcadekit/browser` and `@arcadekit/three`.

What breaks:

- Each module no longer exports a copy of its own namespace, such as `Transform3d_exports` in JavaScript and `Transform3d_d_exports` in its declarations. A game that named one names the module instead.
- The built files of `arcadekit/ecs`, `arcadekit/net` and `arcadekit/browser` are `dist/ecs/index.js`, `dist/net/index.js` and `dist/browser/index.js`. A game that imports the entries by name is not affected.
