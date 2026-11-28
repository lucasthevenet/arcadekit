---
"arcadekit": minor
---

A move from outside that the rules refuse is no turn of a game that `Timeline.keep` keeps. It counted as one: an undo after it went to the game before the refusal, which is the game as it is, and it gave up the turns ahead, so a redo after it found nothing.

Nothing a game writes breaks. An undo after a refused move goes back to before the last move the rules took, and a redo after one still goes forward.
