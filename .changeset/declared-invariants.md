---
"arcadekit": minor
---

A simulation declares its invariants: `invariants` in `Game.Simulation`'s definition names what must hold of every run's state, each a function that reads the state, given as a `Game.ReadonlyState`, and returns true while it holds. A scenario checks every one as its run starts and after every step, and fails with a `ScenarioError` naming the one that broke, the step and the run's seed. `Game.makeLoop` takes options, `Game.LoopOptions`: a loop made with `{ checkInvariants: true }` checks them the same way and throws an `Error`, for a replay or a long run in a test. An engine, a lockstep session and a Co-op client never run them, so play pays nothing for them.

Nothing breaks: `invariants` and the loop's options are new and optional. A simulation that declares an invariant as anything but a function is refused when it is declared.
