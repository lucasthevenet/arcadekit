---
"arcadekit": minor
---

A fiber started during a tick ends with it. One that would still be running once the tick is over, forked with `Effect.forkDetach`, `Effect.forkIn` or into a scope of its own, would change the game at a moment no replay repeats, so the app now refuses it, and the message names the systems that were running when it started. A fiber forked with `Effect.forkChild` is interrupted with the tick as before. The app counts the fibers through `Metric.FiberRuntimeMetrics`, and still passes each start and end on to fiber metrics the game provides.

**Breaking**

- `app.tick` and `app.tickExit`, `app.frame` and `app.input` (and their `Exit` forms) throw when a fiber started while they ran is still running when they end.
- `app.dispatch` and `app.dispatchByName` throw when the handler leaves a fiber running, with the handler's changes undone.
- `App.make` dies when a plugin's `setup` leaves a fiber running.
