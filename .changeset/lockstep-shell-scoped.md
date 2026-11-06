---
"@arcadekit/net": minor
---

Lockstep sessions have an Effect shell. `hostLockstepScoped(options)` and `joinLockstepScoped(options)` take the same options as `hostLockstep` and `joinLockstep` and return `Effect<ScopedLockstepSession, never, Scope>`: closing the scope stops the session listening to its transport, and the session's time is Effect's `Clock` (its monotonic time, so a `TestClock` drives it in tests). `session.run(ticker?)` ticks it until it stops, then fails with its `LockstepError`, instead of the caller polling `session.error` after each tick; interrupting it stops the ticking. After a desync it fails a second after the stop, its ticks resending the desync until then (the transport may lose it), so every peer stops with the same desync. A run left going after its scope closes dies on its next tick. Without a ticker it ticks every 4 ms of the Clock. A `Ticker` (exported) is `(onTick) => stop`, such as a dedicated worker's timer; each tick is a plain call, done before `onTick` returns, with no Effect run per tick, and the run ends once the `onTick` it stops in has returned. `session.listen(onEvent)` hears the run's events while its scope is open, each call with a listener of its own.

`hostLockstep` no longer leaks its transport listener when starting throws (a simulation whose `create` throws, an input source whose `read` throws): it stops listening, then rethrows.

Nothing breaks: the plain sessions, their options and the wire format are unchanged.
