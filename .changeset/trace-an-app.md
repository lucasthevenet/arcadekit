---
"arcadekit": minor
---

`App.make({ trace: true })` sends what the app does to the program's tracer, as spans: one for each tick, holding a span for each action applied in it and for each system's turn, and one for each run of the frame stage and of the input stage, holding their systems'. It costs nothing when off, and doesn't change what the game does.

**Breaking**: `System.withSpan` is gone. A game that wrapped its systems with it creates its app with `trace: true` instead, which traces every system.
