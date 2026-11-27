---
"arcadekit": patch
---

Drawing between two ticks takes less time a frame. Each blend of `Transform2d.smooth`, `Transform3d.smooth` and `Color.smooth` looked over every row it was handed for the largest entity index before its loop, to make room for it, and now makes room when its loop comes to an index past the end. A kind of `@arcadekit/three` drawn with `smooth: true` and a position alone draws as fast as it did before `Transform2d.smooth` came, where it had been 6% to 10% slower, and one with a rotation, a scale or a colour 6% to 11% faster. Nothing breaks.
