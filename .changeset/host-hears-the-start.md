---
"arcadekit": minor
---

A co-op host hears its run from the start. A host's run has started by the time `hostLockstep` returns, before anything can listen to the session, so what that start reported reached no listener: what the simulation's `create` reports, and the run's first sample. A `Coop`'s host seat heard `RunStarted` and then nothing until its first steps, where a guest's seat heard the start. A game whose `create` reports its first stage showed that stage's banner to the guests alone.

A session now keeps what a host's start reported and tells it at its first tick, before the tick does anything else.

- **The Co-op client.** The host's seat hears what `create` reports and then the first sample, after its `RunStarted`, as a guest's seat does: each once, in the same order. A `Coop` and its `match` need no change.
- **`hostLockstep` and `hostLockstepScoped`.** `session.subscribe(listener)` before the session's first tick, or `yield* session.listen(onEvent)` before `session.run(...)`, hears the run from its start. A listener that comes later hears what comes after it, and nothing is told twice. The entry's README has it under "Listening to a run".
- **Nothing else of a session changed.** The run still starts in `hostLockstep`: its state is there at once, and what starting throws is thrown there. What peers exchange, the step a command rides and when steps run are as they were.
- **`arcadekit/net/testing`.** The test game's content takes `offerAtStart: true`: the run then starts on an offer that `create` reports, for a test of what a seat hears first. Left out, the game is as it was.

**What a game written against 0.5.0 may have to change.** Nothing stops compiling. A host's listener hears more than it did, at its session's first tick: a test that lists everything a host's session or seat reported now has the start's events and its first sample in that list, and a workaround that gave a host the start's news another way now gives it twice.
