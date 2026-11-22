---
"arcadekit": minor
---

Two parts of an app are modules of their own: `arcadekit/Schedule`, a game's systems with their turns, by when they run, and `arcadekit/Runner`, which runs a game's code to its end and refuses a fiber that outlives it. `App.make` uses both as before. Nothing breaks.
