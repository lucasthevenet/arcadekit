---
"arcadekit": minor
---

`app.enqueue` and `app.enqueueByName` throw during a tick and from a handler, as `app.dispatch` does, and the message names `Actions.enqueue`. Called from a system, a script or a handler, they logged the action, and a replay applied it twice with no error.

**Breaking**

- Code of the simulation that held the app and called `app.enqueue` or `app.enqueueByName` now throws. Issue the action with `Actions.enqueue`: `(yield* Actions).enqueue(Action, payload)`.
