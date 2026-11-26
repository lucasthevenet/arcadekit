---
"arcadekit": minor
---

`App.Any` takes what an app's systems fail with, `App.Any<E>`, so code that runs any app's `tick`, `frame` or `input` names that failure instead of `unknown`: `App.Any<never>` takes only a game whose systems can't fail, and a function generic in `E` takes any app and passes on what its systems fail with. An `App.App<E, HU>` is an `App.Any<E>`.

Nothing breaks: bare `App.Any` is the type it was, and its `tick`, `frame` and `input` still fail with `unknown`.
