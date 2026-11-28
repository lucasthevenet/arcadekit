---
"arcadekit": minor
---

`app.enqueueByName` refuses a payload that is no JSON value, such as none at all, where it is called, as `app.enqueue` refuses one that has no JSON form. `app.enqueueByName("duel/Pass")` typed in the console was queued and logged, refused when its tick came with only an `Action.Rejected` to say so, and left a recording that `Replay.encode` could not write. In a session, the peer's next message could not be encoded. A JSON payload the schema refuses is still an `Action.Rejected` on every peer.

**Breaking**

- `app.enqueueByName` returns `Effect<void, Action.InvalidPayload>`, which fails, with nothing queued, logged or sent, for a payload that is no JSON value. The JSON form of no payload is `null`: `app.enqueueByName("duel/Pass", null)`. So does the `enqueueByName` of `App.Steered`.
- `Replay.verify` and `Replay.play` stop with `Replay.Diverged` at an entry of the log whose payload is no JSON value, which only a log written by hand holds.
