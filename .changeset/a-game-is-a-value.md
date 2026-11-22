---
"arcadekit": minor
---

A game is a value, and an app is one run of it. `App.define({ plugins, systems, handlers, version, migrations })` says what the game is, which is the same every time it is played, and `App.make(game, start)` starts a run of it: from a `seed`, or from a `save`.

What breaks:

- `App.make(options)` is `App.make(App.define(options), start)`. `seed`, `checkpointEvery` and `verifyFrames` are no longer among a game's options: they say how a run starts, and are `App.make`'s second argument.
- `App.load(save, options)` is gone: `App.make(game, { save })` continues a saved game. A `save` and a `seed` given together don't typecheck, and are refused with what to give instead.
- `App.run` is `Driver.run`, and takes the effect that makes the app, not yielded: `App.run(options, { hz, save })` is `Driver.run(App.make(game, { save }), { hz })`. How a run starts is said once, to `App.make`, and what steps an app is all in `arcadekit/Driver`.
- `App.run`'s `ready` is gone, and so is `App.RunOptions`: `Driver.run`'s options are `Driver.StepOptions`. What `ready` did is a step of the effect that makes the app, `App.make(game).pipe(Effect.tap((app) => ...))`, and what it acquires is still released with the app.
- A version that isn't a whole number from 0 up is refused by `App.define`, where the game is written, and no longer when its first app is made.

`arcadekit/Build` is a new entry: what puts an app together, which `App.make` calls.
