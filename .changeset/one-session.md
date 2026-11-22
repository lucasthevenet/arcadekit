---
"arcadekit": minor
---

There is one session, and it makes its app. `Session.make(game, { seed, peer, peers, delta })` takes the game, as `App.make` does, and returns a session whose `app` it steps. `ahead` says how many ticks it runs past what every peer has sent, 8 by default, and `ahead: 0` is lockstep. `session.app` is an `App.Steered`: an app without `tick`, `tickExit`, `dispatch` and `dispatchByName`, so stepping a session's app yourself doesn't compile, where it threw.

What breaks:

- `Lockstep` and `Rollback` are gone. `Lockstep.make(app, options)` is `Session.make(game, { ...start, ...options, ahead: 0 })`, and `Rollback.make(app, options)` is `Session.make(game, { ...start, ...options })`, where `start` is what the app was made with: its `seed` or `save`, `checkpointEvery`, `verifyFrames`. The game's code reaches the app as `session.app`.
- `delay` defaults to 0, and to 2 for a session whose `ahead` is 0: what the two modules defaulted to.
- `Rollback.syncTest(app)` is `Session.syncTest(game, start)`, an effect, and its app is `test.app`. `Rollback.RewindDiverged` is `Session.RewindDiverged`.
- What peers say to each other is `arcadekit/Netcode`: `Lockstep.Message`, `Lockstep.Issued`, `Lockstep.encode`, `Lockstep.decode` and `Lockstep.Drifted` are `Netcode.Message`, `Netcode.Issued`, `Netcode.encode`, `Netcode.decode` and `Netcode.Drifted`. A transport and a relay import it, and no app with it.
- `app.divert` and `App.Diverted` are gone from an app. Taking an app over is `Build.build(game, start)`, which returns the app with `take`, and `App.Diverted` is `Build.Reins`. A session is the only thing in the package that takes one over.
- `Lockstep.Session` and `Rollback.Session` are `Session.Session`, whose `tickExit` can fail with `Save.SaveRefused` whatever its `ahead`.
- The guide "Lockstep and rollback" is "Sessions", at `/guides/sessions`.
