---
"arcadekit": minor
---

A recording holds `endHash`, the world's hash where it ends, and `Journal.replay` compares it once the last tick has run, whatever `checkpointEvery` was. A replay that succeeds ended on the world the recorded game ended on. Only `app.record()` and `Journal.decode` make a `Journal.Recording`.

**Breaking**

- `Journal.Played`, and so `Journal.Recording`, has a new field, `endHash`.
- `Journal.Recording` is branded: an object literal no longer compiles as one. A test that wrote a recording by hand takes `app.record()`, and one that edits a recording edits its text and reads it back with `Journal.decode`.
- `Journal.decode` refuses a recording that an earlier version wrote, with no `endHash`, with a message that begins `older format`. Record it again.
- A replay of a recording made with `checkpointEvery: 0`, or of one whose last checkpoint is before its end, that ends on another world fails with `Journal.ReplayDiverged`, where it succeeded. Its `entry` is a checkpoint of the recording's `end` and `endHash`, and its `index` is the log's length.
- `Journal.replay` no longer throws on a recording whose `start` isn't where its seed or save begins, or whose first run of deltas doesn't begin at its `start`, and no longer fails with "was never reached" for a log past the recording's end. `Journal.decode` refuses all three, and only it and `app.record()` make a recording.
