---
"arcadekit": minor
---

`app.phase` says what an app is running: `"idle"` between ticks, `"tick"`, `"frame"`, `"input"`, or `"handler"` for an action's handler that `dispatch` runs. A handler a tick runs is part of the tick. The app's own between-ticks checks read it, and they now refuse what a handler `dispatch` runs did unchecked: a tick, a frame, the input stage, a save, a capture, a recording, a checkpoint or an inspection taken halfway through an action, which the action could still take back.

**Breaking**

- `app.tick()`, `app.frame()`, `app.input()`, `app.save()`, `app.capture()`, `app.record()`, `app.checkpoint()` and `app.inspect()` throw when called from a handler that `dispatch` runs. Call them after `dispatch` returns.
- `app.checkpoint()` also throws during the frame and input stages, as the others do.
- `app.rewind()` from a handler says `was called during a handler of "…"`, where it said `was called from the handler of "…"`.
