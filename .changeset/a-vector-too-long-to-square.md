---
"arcadekit": patch
---

`Vec2.length`, `Vec2.distance`, `Vec2.normalize` and `Vec2.clampLength` measure a vector longer than about 1e154 or shorter than about 1e-154, whose square a double cannot hold. `Vec2.length(1e200, 0)` was `Infinity` and is `1e200`, `Vec2.normalize` of `(1e-200, 0)` was `(0, 0)` and is `(1, 0)`, and `Vec2.clampLength` of `(1e200, 0)` to `1` was `(0, 0)` and is `(1, 0)`. Such a vector is scaled by a power of two before it is squared, so the result is still the same in every engine. Nothing breaks: any other vector gives the same bits as before, so a replay recorded before ends on its hash unless its game measured such a vector.
