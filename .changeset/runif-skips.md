---
"arcadekit": minor
---

A system that `System.runIf` turns off sees nothing of what happened while it was off: its change queries and `Query.removed` readers skip what changed while it didn't run, as it already heard no event from then. So what a system missed has one rule, and a log of changes no longer grows for a system that stays off. `EcsWorld.skip(reader)` is what an app calls for each system that doesn't run.

**Breaking**

- A change query of a system that didn't run no longer holds what changed in the meantime: when the system runs again, it visits only what changed after its last skipped turn. A system that must know the state of the game when it comes back reads it with an ordinary query or a singleton. A change query it has never visited still visits everything that matches.
