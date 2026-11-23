---
"arcadekit": minor
---

`Driver.run` takes the game and makes its app itself, with the options of `App.make` beside its own: `Driver.run(Duel, { hz: 60, seed: 1 })`. Nothing can come between the making and the run, so a step that fails after the app is made can no longer leave it open, with the page's devices and sound. Connect something to the app before its first frame with `ready`. When `ready` fails, the run closes the app.

**Breaking**: `Driver.run` no longer takes an effect that makes an app. Where a game wrote `Driver.run(App.make(game, { seed }), { hz: 60 })`, it writes `Driver.run(game, { seed, hz: 60 })`. A step tapped onto `App.make` goes in `ready`. A program that makes its app itself runs it with `Driver.frames`, and closes it. `Driver.run` still takes an effect that makes a session, or a session connected to its transport.
