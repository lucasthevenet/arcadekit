---
"arcadekit": minor
---

`App.make({ verifyRewinds: true })` checks that a tick runs the same when a rewind runs it again, as a rollback session does. Each tick is run, rewound and run again from the same moment, and the world's hash is compared before the first system and after each one. `tick` throws `App.RewindDiverged`, naming the first system after which the hashes differ, or none when they differed in a handler or a state's hook. This finds what a tick reads that a rewind doesn't put back: state kept in a service, a plugin or a module, or a value from outside the game. The frame and input stages, the action log and the recording see each tick once. A game whose moments can't be captured can't use it: `tick` throws the refusal.
