---
"arcadekit": minor
---

A game is recorded as one value that says how it was played. `app.record()` returns an `App.Recording`: the action log, the ticks it begins and ends at, and the delta of every tick, kept as runs of ticks that took the same delta. `App.replay(app, recording)` takes nothing else, so a replay can't be given the wrong tick length or stop short. It throws when the app isn't at the recording's first tick. `app.record(save)` records since a save of the app, for an app loaded from that save to replay. `App.encodeRecording` and `App.decodeRecording` turn a recording into text and back, and decoding refuses one whose log or runs of deltas are out of order or outside it.

**Breaking**

- `App.replay(app, log, { delta, ticks })` is now `App.replay(app, app.record())`. For the tail since a save, `App.replay(loaded, app.record(save))` replaces `App.replay(loaded, app.actionLog.slice(save.logLength), { delta, ticks })`.
- `Action.encodeLog` and `Action.decodeLog` are removed. Use `App.encodeRecording` and `App.decodeRecording`, which write and read the whole recording.
