---
"arcadekit": minor
---

Capturing a game and putting it back are a module of their own, `arcadekit/Timeline`, and no longer members of an app: a game that never goes back imports none of it.

This breaks callers of four members and one type:

- `app.capture()` is `Timeline.capture(app)`, and `app.rewind(moment)` is `Timeline.rewind(app, moment)`.
- `App.Moment` is `Timeline.Moment`.
- What `app.divert` returns no longer has `capture` and `rewind`. A session that goes back to run the same ticks again calls `Timeline.rewind(app, moment, { again: true })`, and one that rewinds before the frame and input stages run again captures with `Timeline.capture(app, { stages: true })`.

The messages of a refused call begin with `Timeline.capture()` and `Timeline.rewind()`, and one made from an action's handler says "an action's handler" without naming the action.

An app's log is a store of its world, as its events and its queued actions are, so a rewind takes it back with the world.
