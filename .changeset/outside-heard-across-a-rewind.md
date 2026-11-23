---
"arcadekit": minor
---

Code outside the game that reads an event hears across a rewind what the frame and input stages hear. It used to skip every event told between a rewind and its next read, so a UI or a sound that listened that way missed them. Now its next read returns what was told since the moment the rewind went back to, and after a rewind with `again`, each event of the ticks run again once.

**Breaking**

- A handle that outside code reads no longer skips to the newest event after a rewind. Code that relied on that skip reads the state it needs from the world instead.
