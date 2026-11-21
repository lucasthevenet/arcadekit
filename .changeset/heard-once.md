---
"arcadekit": minor
---

The frame and input stages hear each event once across a rewind. Until the game has run again the ticks it had run before going back, an event those ticks emit again, with the same payload, isn't heard a second time: a cue doesn't play twice when rollback resimulates its tick. What the ticks now do otherwise is heard as new, and so is everything after them. This holds even when the events were dropped since the moment was captured, because the app keeps them while a moment is held.

**Breaking**

- A frame-stage or input-stage system no longer reads again the events of a tick a rewind runs again. One that relied on hearing them again reads the state it needs from the world.
