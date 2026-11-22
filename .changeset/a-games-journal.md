---
"arcadekit": minor
---

A game's log, its recording and its replay are a module of their own, `arcadekit/Journal`, where they were part of `App`. An app still keeps the log and makes the recording: `app.actionLog`, `app.record()` and `app.checkpoint()` are where they were.

**Breaking**

- `App.replay(app, recording)` is `Journal.replay(app, recording)`.
- `App.Recording` is `Journal.Recording`.
- `App.encodeRecording` and `App.decodeRecording` are `Journal.encode` and `Journal.decode`.
- `App.HashMismatch` and `App.ReplayDiverged` are `Journal.HashMismatch` and `Journal.ReplayDiverged`.
- A message that began `App.replay was given` begins `Journal.replay was given`.
