---
"arcadekit": minor
---

A recording holds how its game began, and a replay hands that to what makes its app. `app.record()` returns the game's `seed` with its log, or the `save` it was recorded since, in the words `App.make` takes. `Journal.replay(recording, (start) => App.make(game, start))` makes the app from that start, so a replay can't be given the wrong seed, plays the recording in it and returns it where the recording ends.

What breaks:

- `Journal.replay(app, recording)` is `Journal.replay(recording, (start) => App.make(game, start))`: it takes the recording and a function that makes the app from how the recorded game began, and is an effect itself. A game that made its app with `{ seed }` and replayed into it now makes it from `start`.
- A replay that diverges fails with `Journal.ReplayDiverged` in the effect's error channel, and no longer throws it. To look at the app a replay stopped in, keep it in the function that makes it, with `App.make(game, start).pipe(Effect.tap((app) => ...))`.
- `Journal.Recording` has a `seed` or a `save`, one of the two. A recording built by hand needs one, and `Journal.decode` refuses text without one: recordings encoded before this don't decode.
- A recording made with `app.record(save)` holds that save, so its text from `Journal.encode` is longer by the save. Replaying it needs no `App.make(game, { save })` first: `Journal.replay(tail, (start) => App.make(game, start))`.
- An app made from a save keeps the save for as long as it lives, to record from.
