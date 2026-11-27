---
"arcadekit": minor
---

`Transform3d.axisAngle` gives the same numbers in every JavaScript engine, so a tick may call it. Its sine and cosine are fdlibm's, the ones V8's `Math.sin` and `Math.cos` give, made of `+`, `-`, `*` and `/`, and it measures its axis with `Math.sqrt` in place of `Math.hypot`. ECMAScript lets each engine round `Math.sin`, `Math.cos` and `Math.hypot` its own way, so two peers on different engines could compute two rotations. Nothing breaks: a game calls it as before. A rotation it returns may differ from before in its last bit.
