---
"arcadekit": minor
---

Going back in a game has a module of its own, `Timeline`: `Timeline.capture(app)` captures the game in memory as a `Timeline.Moment`, and `Timeline.rewind(app, moment)` puts the same app back to it, in place. They do what `app.capture()` and `app.rewind()` did. A game that never goes back no longer carries them on its app, and `Lockstep`, `Rollback.syncTest` and an undo use the same two functions.

**Breaking**

- `app.capture()`, `app.rewind()` and `App.Moment` are removed: use `Timeline.capture(app)`, `Timeline.rewind(app, moment)` and `Timeline.Moment`. Their errors now begin `Timeline.capture()` and `Timeline.rewind()`.
- `Lockstep.SessionApp` and `Rollback.SyncTestApp` no longer pick `capture` and `rewind` from `App.App`: each is an `App.Any` with the members it uses.
