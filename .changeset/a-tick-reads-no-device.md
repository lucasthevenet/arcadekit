---
"arcadekit": minor
---

A tick reads no device. The input stage runs only when something runs it: a driver before each tick, a session before each of its ticks, or `app.input()` by hand. A tool that re-runs a game from its log ticks it with `app.tick(delta)` alone, and the keys and the UI of the machine it runs on cannot reach the game.

**Breaking**

- `app.tick(delta)` and `app.tickExit(delta)` no longer run the input stage when nothing has since the previous tick. A game or a test that steps its app by hand and reads the devices or a `View.Bridge` calls `app.input()` before each tick that is to receive them.
- `App.TickOptions` and the second argument of `tick` and `tickExit` are removed. Replace `app.tick(delta, { input: false })` with `app.tick(delta)`.
- The `Action.INTAKE` store of a save and of `app.inspect().stores` is `{ queued }`, no longer `{ queued, heard }`. A save holds no store for it when no action is queued. A save written with `heard` still loads, and `heard` is ignored.
