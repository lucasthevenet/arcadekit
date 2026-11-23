---
"arcadekit": minor
---

A session is told how long a tick is once, by its `delta`. `session.tick()` and `session.tickExit()` take no delta, and a driver given a session, or a session connected to a transport, ticks it `1 / delta` times a second: `Driver.frames(yield* Transport.connect(session))`. `fixedStep`, `interval`, `frames` and `run` have a signature for a session, which takes neither `hz` nor `ticks`, so a driver at another rate than the session's and a session that rests with `ticks: "whenNeeded"` don't compile, and the error says why. `Driver.Paced` is what ticks by a `delta` of its own, and `Driver.PacedOptions` what a driver given one takes: `maxStepsPerCall`.

**Breaking**

- Replace `Driver.frames(connected, { hz: 60 })` with `Driver.frames(connected)`, and the same for `fixedStep`, `interval` and `run`. A session given `hz` or `ticks` no longer compiles, where a rate other than `1 / delta` threw at its first tick.
- `session.tick(delta)` and `session.tickExit(delta)` are `session.tick()` and `session.tickExit()`, and `Transport.Connected`'s `tick` takes no delta.
- `Transport.connect` takes the session's `delta` too, and `Transport.Connected` has it. `Peer.Peer` and `Transport.Connected` extend `Driver.Paced`, not `Driver.Tickable`.
- `Driver.Tickable` has `delta?: never`: a tickable with a `delta` of its own is a `Driver.Paced`.
