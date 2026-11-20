---
"arcadekit": minor
---

`app.inspect()` copies what a game holds and what it did last, as plain data to read in the console, show in a game's own UI or check in a test: every entity with its components, the singletons, every system with whether its last turn ran it and how long that took, and the events of the last tick. The storage core's `World` gains `contents()`, which copies its entities and singletons.

**Breaking**: an object that implements `App.Any` by hand needs `inspect` too. Nothing else changes.
