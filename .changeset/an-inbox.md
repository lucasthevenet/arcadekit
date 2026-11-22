---
"arcadekit": minor
---

How an action enters a game is a module of its own, `arcadekit/Inbox`: queueing it for the next tick, applying it now, the transaction around its handler, and handing it to a session that has taken the app over. `App.make` uses it as before, and an app's `enqueue`, `dispatch`, `enqueueByName` and `dispatchByName` are unchanged. A `Runner` now also says what the app is running: `phase`, `simulating`, `whileIdle`. Nothing breaks.
