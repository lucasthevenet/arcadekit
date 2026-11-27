---
"arcadekit": minor
---

`Timeline.keep` captures the game when a move arrives, before the tick or the dispatch that applies it, and a tick with no move captures nothing. A game that ticks by itself at rest no longer captures itself 60 times a second: a tick of a clock and 1,000 pieces at rest cost 4.2 µs with its turns kept and 1.6 µs without, and now costs what it does without.

- A redo of a turn that the rules went back, with a `Timeline.Undo` that a system or a handler enqueued, stays where it went. It used to go to the game with that undo still queued, which the next tick applied again.
- A game that can't be captured dies with keep's error when a move arrives, in the enqueue, the dispatch or the input stage that issued it, where it died in the tick after.

Nothing a game writes breaks.
