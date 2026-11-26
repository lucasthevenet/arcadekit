---
"arcadekit": minor
---

Every method of an app returns an Effect, and a program yields it. `yield* app.tick(delta)` runs a tick and fails with what the game's systems fail with, and so do `app.frame` and `app.input`. `app.dispatch` fails with the action's refusal, `app.dispatchByName` with what the game's actions are refused with, `Action.UnknownAction` or `Action.InvalidPayload`, and `app.save` with `Save.SaveRefused`. What a driver steps answers the same way: `Driver.Tickable`, `Driver.Paced`, a session, `Transport.Connected` and `Session.syncTest`. What a session's tick threw, `Drift.Unlike`, `Drift.Drifted`, `Transport.Left` and `Session.RewindDiverged`, is now a failure that `Driver.run` fails with, so a program catches it by its tag. A call made where it may not be, such as `app.tick` from inside a tick, dies with the message it threw. `app.time`, `app.phase`, `app.settled`, `app.actionLog` and the lists of names stay values, and a view bridge's `send`, `get` and `subscribe` stay plain calls for a UI.

What breaks, for every caller of these:

- `app.tick(delta)`, `app.frame(alpha, delta)` and `app.input()` are `yield* app.tick(delta)`, `yield* app.frame(alpha, delta)` and `yield* app.input()`. `app.tickExit`, `app.frameExit` and `app.inputExit` are gone: `yield* Effect.exit(app.tick(delta))` gives the outcome as a value.
- `app.dispatch(Move, payload)` and `app.dispatchByName(name, json)` returned an `Exit`. They return an Effect: `yield* app.dispatch(Move, payload)` succeeds with what the handler returns, and `yield* Effect.exit(app.dispatch(Move, payload))` is the `Exit` it returned.
- `app.enqueue(Move, payload)` is `yield* app.enqueue(Move, payload)`, which fails with `Action.InvalidPayload` as its `Exit` did, and `app.enqueueByName(name, json)` is `yield* app.enqueueByName(name, json)`.
- `app.save()` is `yield* app.save()`, which fails with `Save.SaveRefused`. `app.record(since)`, `app.checkpoint()` and `app.inspect()` are `yield* app.record(since)`, `yield* app.checkpoint()` and `yield* app.inspect()`.
- `Timeline.capture(app)` returned an `Exit`: it is `yield* Timeline.capture(app)`, which fails with `Save.SaveRefused`. `Timeline.rewind(app, moment)` is `yield* Timeline.rewind(app, moment)`.
- `Driver.fixedStep(app, { hz })` returns a step to yield: `yield* step(seconds)` succeeds with the ticks it ran. A hand-made `Driver.Tickable` or `Driver.Paced` returns an Effect from `tick`, `input` and `frame`.
- `session.tick()`, a connected session's `tick()` and a sync test's `tick(delta)` are `yield* session.tick()` and so on. `session.tickExit()` and a sync test's `tickExit(delta)` are gone. A sync test's `tick` fails with `Session.RewindDiverged` where it threw, and a connected session's with `Transport.Left`.
- `Driver.run`, `Driver.frames` and `Driver.interval` fail with what a tick or a frame fails with, where they died with what it threw. `Journal.replay` fails with what a tick of the replay fails with.
