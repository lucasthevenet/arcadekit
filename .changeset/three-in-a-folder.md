---
"@arcadekit/three": minor
---

`@arcadekit/three/Three` is written in a folder, `src/three/`, and each of its parts is a module and an entry of its own: `@arcadekit/three/three/Scene`, `Renderer`, `Which`, `Loading` (`texture` and `manager`), `Instances` and `Objects`. Each gives the same values `Three` gives, and has its own page in the reference. Their implementation is in `src/three/internals/`, which is no entry.

Nothing breaks: `@arcadekit/three/Three` and `import { Three } from "@arcadekit/three"` give what they gave, from `dist/Three.js` as before. The new entries only add.
