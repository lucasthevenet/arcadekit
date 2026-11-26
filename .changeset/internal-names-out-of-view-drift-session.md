---
"arcadekit": minor
---

`View.Sent`, `Drift.make`, `Drift.Comparison` and `Session.Repeated` are no longer exported. No game, platform or stand-in writes or names them, and they are now internal to the package. `arcadekit/net/Drift` holds the two errors a session stops with, `Drift.Unlike` and `Drift.Drifted`.

What breaks:

- `View.Sent`, an action a UI sent and the input stage has not issued yet, is gone. A UI sends with `ui.send(action, payload)`, as before.
- `Drift.make` and the `Drift.Comparison` it made, one peer's comparison of the hash checks, are gone. A session compares them itself and stops with `Drift.Drifted` or `Drift.Unlike`, as before.
- `Session.Repeated` is gone. `Session.make` still refuses a name given twice, at compile time, with the same message.

A platform author imports nothing new: what a platform gives arcadekit, such as `Input.Listener`, `Sound.Speaker` and `Assets.LoaderShape`, and what a driver steps, `Driver.Tickable`, `Driver.Paced` and `Driver.Closes`, stay where they were.
