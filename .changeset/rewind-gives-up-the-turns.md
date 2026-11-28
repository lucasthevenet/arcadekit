---
"arcadekit": minor
---

`Timeline.rewind` gives up every turn that `Timeline.keep` kept, as `app.load` does: they are of the game the rewind left. An undo after a rewind from outside used to go to one of them, a game between two moves the rewind had taken back.

Nothing a game writes breaks. `Timeline.undo` after a rewind succeeds with `false` until the next move, where it went to a turn of the game the rewind left. A rewind forward to a moment with more moves in its log no longer counts as a turn.
