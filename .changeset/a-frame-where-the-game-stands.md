---
"arcadekit": minor
---

`app.frame()`, `app.frameExit()` and a `Session.syncTest`'s `frame()` take their `alpha` as optional, and run without one at an `alpha` of 1: a game stepped by hand is drawn where its last tick left it, including a kind of `@arcadekit/three` drawn with `smooth`, which `app.frame(0)` draws where it was a tick before. Nothing breaks: a call with an `alpha` does what it did.
