---
"arcadekit": minor
---

A frame or input system that requires a `Scope` no longer compiles, as a tick system already did not. It was given the app's scope, so what it opened on each frame, such as a bundle from `Assets.load`, was kept until the app closed, with no error.

What breaks:

- A frame or input system that yields `Assets.load`, `Effect.acquireRelease`, `Scope.Scope` or anything else that requires a `Scope` is refused where it is written. A system holds a bundle with `Assets.during` or `Assets.Store`. What lasts as long as the app is opened in a plugin's `layer`.
