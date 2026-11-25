---
"arcadekit": patch
"@arcadekit/three": patch
---

A namespace of an entry that gathers modules is that module, in the built packages as in the source. `import { Transform3d } from "arcadekit"` is the module `arcadekit/Transform3d`, at run time and in its type, so it can be passed as `transform` to `Three.instances` and `Three.objects`. The same holds for each module of `arcadekit`, `arcadekit/net`, `arcadekit/browser` and `@arcadekit/three`.

The build gave each such module an extra export of its own namespace, `Transform3d_exports`, typed `Transform3d_d_exports`, and the index's `Transform3d` was that object, whose type the module's wasn't assignable to. Those extra exports are gone. Nothing a game writes breaks.
