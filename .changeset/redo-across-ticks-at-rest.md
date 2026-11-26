---
"arcadekit": minor
---

A game that ticks by itself keeps its redo until the next move. `Timeline.redo` and the action `Timeline.Redo` go forward after the ticks a game runs at rest, where they used to find nothing one tick after the undo.

- A move, a load or a rewind gives up every turn ahead. A tick that applies no move from outside gives up none, and neither does an undo or a redo with no turn to go to.
- A redo puts the game as it was at the undo, its time with it, and gives up the ticks run since.

Nothing a game writes breaks. A redo after ticks at rest now succeeds with `true` and goes forward, where it succeeded with `false`.
