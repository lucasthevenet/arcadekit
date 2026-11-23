---
"arcadekit": minor
---

`Journal.replay` takes the game and makes the app itself, from how the recording says its game began, so a replay can't begin anywhere else. Its options are the rest of what `App.make` takes, `Journal.ReplayOptions`, which has no `seed` and no `save`. A replay that diverges fails with a `Journal.ReplayDiverged` that holds the replay's app, `diverged.app`, where it stopped.

**Breaking**

- `Journal.replay(recording, (start) => App.make(game, { ...start, checkpointEvery: 1 }))` is `Journal.replay(recording, game, { checkpointEvery: 1 })`, and `Journal.replay(recording, (start) => App.make(game, start))` is `Journal.replay(recording, game)`. A `seed` or a `save` in the options doesn't compile.
- The app to look at when a replay has stopped is no longer kept with `Effect.tap` in the function that made it. It is the error's: `Effect.catchTag("ReplayDiverged", (diverged) => diverged.app.read(World))`.
- Code that made its app some other way than from the start it was handed, or prepared it before the replay began, has no place to do so. A game whose systems call an app they keep in a variable enqueue through `Action.Actions` instead, which is the same move from inside the simulation.
- `Journal.ReplayDiverged` has a type parameter, the app, and an `app` field.
- The refusal of an app that isn't where the recording begins is gone, with the function that could make one. A recording built by hand whose seed or save doesn't begin where it does is still refused when it is replayed, as `Journal.decode` refuses its text.
