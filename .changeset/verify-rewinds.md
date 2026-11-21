---
"arcadekit": minor
---

`Rollback.syncTest(app)` checks that a tick runs the same when a rewind runs it again, as a rollback session does. It takes the app over, as a session does, and each tick it is stepped through is run, rewound and run again from the same moment, with the world's hash compared before the first system and after each one. `tick` throws `Rollback.RewindDiverged`, naming the first system after which the hashes differ, or none when they differed in a handler or a state's hook. This finds what a tick reads that a rewind doesn't put back: state kept in a service, a plugin or a module, or a value from outside the game. The frame and input stages, the action log and the recording see each tick once.

What took an app over with `app.divert` can now also capture it with the frame and input stages' place kept, and be told when each system of a tick has run.
