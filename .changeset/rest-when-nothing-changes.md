---
"arcadekit": minor
---

A game that ticks only when needed rests after a tick that changed nothing but its time, which the app tells from the world's hash. A clock that runs or a body in flight keeps it ticking with nothing to declare, and an action dispatched between ticks wakes it. The app hashes its world after each tick from the first time `app.settled` is read: about 10 µs for a thousand entities, 0.9 ms for a hundred thousand. A game that ticks in real time pays nothing.

**Breaking**

- `Ticks` and `Ticks.more` are removed. Delete the calls: a system with work every tick changes the world, and that keeps the game ticking.
- A driver with `ticks: "whenNeeded"` no longer runs one more tick after the game is settled, and a new game rests after its first tick when that tick changed nothing. The first read of `app.settled` is false.
- A system that waits for a moment of game time by comparing it with `Time`, writing nothing while it waits, is never reached in that mode: count down in the world.
