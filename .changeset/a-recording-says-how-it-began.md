---
"arcadekit": minor
---

A recording holds how its game began, and a replay is given the making of its app. `app.record()` returns the game's `seed` with its log, or the `save` it was recorded since, in the words `App.make` takes: `App.make(game, recording)` makes an app that begins as the recorded game did, so a replay can't be given the wrong seed. `Journal.replay(App.make(game, recording), recording)` plays the recording in that app and returns it where the recording ends.

What breaks:

- `Journal.replay(app, recording)` is `Journal.replay(App.make(game, recording), recording)`: it takes the effect that makes the app, not yielded, and is an effect itself. A game that made its app with `{ seed }` and replayed into it now makes it from the recording.
- A replay that diverges fails with `Journal.ReplayDiverged` in the effect's error channel, and no longer throws it. To look at the app a replay stopped in, keep it with `App.make(game, recording).pipe(Effect.tap((app) => ...))`.
- `Journal.Recording` has a `seed` or a `save`, one of the two. A recording built by hand needs one, and `Journal.decode` refuses text without one: recordings encoded before this don't decode.
- A recording made with `app.record(save)` holds that save, so its text from `Journal.encode` is longer by the save. Replaying it needs no `App.make(game, { save })` first: `Journal.replay(App.make(game, tail), tail)`.
- An app made from a save keeps the save for as long as it lives, to record from.
