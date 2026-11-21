---
"arcadekit": minor
---

`app.phase` says what an app is running: `"idle"` between ticks, `"tick"`, `"frame"`, `"input"`, or `"handler"` for an action's handler that `dispatch` runs. A handler a tick runs is part of the tick. The app's own between-ticks checks read it. Nothing breaks.
