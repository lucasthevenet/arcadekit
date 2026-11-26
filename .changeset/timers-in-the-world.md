---
"arcadekit": minor
---

`arcadekit/Timer` keeps timers in the world: `Timer.field` for a cooldown that a system counts down with `Timer.tick` and checks with `Timer.ready`, `Timer.lifetime(seconds)` for an entity that `Timer.plugin` despawns when its time is up, and `Timer.every(seconds)`, which runs a system of the tick once per period and keeps the time to its next run in a singleton named after the system. A save holds each, the hash covers each, and a replay fires them on the same ticks. Nothing breaks.
