---
"arcadekit": minor
---

A transport's `send` and `receive` return an Effect, which fails with `Transport.Closed` once its socket has closed for good. A connected session's `tick` fails with it, and so does `Driver.run` of a game of several peers, so a program catches it by its tag, `"TransportClosed"`, beside `Transport.Left`, `Drift.Unlike`, `Drift.Drifted` and `Save.Refused`. A transport used after its connection was closed dies, and says so, where it threw.

What breaks:

- `listener.send(message)` and `listener.receive()` of a `Transport.Listener`, from `Transport.listen`, a hub's `port` or `Transport.fromWire`, are `yield* listener.send(message)` and `yield* listener.receive()`. Where `receive` threw `Transport.Closed`, `yield* Effect.result(listener.receive())` gives it as a value.
- A `Transport.Listener` written by hand returns an Effect from both calls, `Effect.sync(...)` for one that cannot fail.
- `Driver.run` of a connected session fails with `Transport.Closed`, where it died with it.
