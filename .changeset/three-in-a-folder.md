---
"@arcadekit/three": minor
---

The parts of `@arcadekit/three/Three` are modules and entries of their own, each with its page in the reference: `@arcadekit/three/Scene`, `@arcadekit/three/Renderer`, `@arcadekit/three/Assets` (`texture` and `manager`), `@arcadekit/three/Instances` and `@arcadekit/three/Objects`. `Three` re-exports each, so either import gives the same values. Their implementation is in `src/internal/`, which is no entry.

Nothing breaks: `@arcadekit/three/Three` and `import { Three } from "@arcadekit/three"` give what they gave. The new entries only add.
