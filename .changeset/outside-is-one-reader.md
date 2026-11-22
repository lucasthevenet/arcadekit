---
"arcadekit": minor
---

Code outside the simulation (a test, the entry point) is one reader of an event, as it already was of a change query and of `Query.removed`: there is one reader there, shared by every caller there. `(yield* SomeEvent).read()` and `app.events.handle(SomeEvent).read()` now go on from where the last read stopped, so outside code that reads after each tick hears each event once. Before, each of them made a new handle that started from now, so it heard nothing. The first read hears the last tick, what was emitted between it and the one before, and what has been emitted since. Outside code that doesn't read an event for 600 ticks is taken to be gone, as a stage is, and next reads it as for the first time. A rewind moves outside code as it moves the frame and input stages, and with `again` it doesn't hear twice what it heard of the ticks that run again.

**Breaking**

- `app.events.handle(SomeEvent)`, and `yield* SomeEvent` with `Events` provided as `app.events`, return the same handle every time instead of a new one. Code that asked again to skip what was emitted before now hears it: read once and drop the result instead.
- Two outside callers of one event share its position: the second hears only what the first has not read. Code that needs two places of its own reads once and hands the result to both.
- The first read of an event outside hears the last tick, where a new handle heard nothing.
