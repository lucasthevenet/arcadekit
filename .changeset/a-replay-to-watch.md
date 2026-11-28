---
"arcadekit": minor
---

A recording can be watched, at its own pace, in a page: `Replay.play(recording, game)` makes a player, which `Driver.run` steps a recorded tick at a time and draws, and which pauses, goes faster and goes to any tick. And each thing a game is kept as has one name: a moment, a save, a recording, a snapshot and a hash check.

```ts
Driver.run(Replay.play(recording, Duel), {
  ready: (player) => Effect.andThen(player.play(2), player.seek(1200)),
});
```

`Journal` is `Replay`, and taking a save, a recording or a hash check is a function, as capturing a moment is.

**Breaking**

- `arcadekit/Journal` is `arcadekit/Replay`. `Journal.replay(recording, game)` is `Replay.verify(recording, game)`, `Journal.ReplayDiverged` is `Replay.Diverged`, whose tag `"JournalReplayDiverged"` is `"ReplayDiverged"`, and `Journal.ReplayOptions` is `Replay.Options`. `Journal.HashMismatch`, `Journal.Invalid`, `Journal.Recording`, `Journal.Origin`, `Journal.Played`, `Journal.encode` and `Journal.decode` are `Replay`'s, and the tags `"JournalHashMismatch"` and `"JournalInvalid"` are `"ReplayHashMismatch"` and `"ReplayInvalid"`.
- A checkpoint is a hash check: the option `checkpointEvery` of `App.make`, `Replay.verify` and `Session.make` is `hashEvery`, `Action.Checkpoint` is `Action.HashCheck`, and `Action.isCheckpoint` is `Action.isHashCheck`. A message's `checkpoints` keeps its name, and its bytes.
- An app's methods for what is kept of it are functions: `app.save()` is `Save.make(app)`, `app.load(save)` is `Save.load(app, save)`, `app.record(since)` is `Replay.record(app, since)`, and `app.checkpoint()` is `Replay.hashCheck(app)`. Their messages when called where they may not be name the functions.
- A save no longer holds the length of the log that made it: `Save.Save` has no `logLength`. The app knows where each save it made is in its log, so `Replay.record(app, save)` takes a save the app made, or the one it was made or loaded from, and dies for any other. A save is written in format 4, and one in format 3 is still read.
