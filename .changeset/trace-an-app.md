---
"arcadekit": minor
---

An app traces itself when the program provides a tracer: it sends what it does as spans, one for each tick, holding a span for each action applied in it and for each system's turn, and one for each run of the frame stage and of the input stage, holding their systems'. `App.make({ trace: false })` turns it off with a tracer provided, and `trace: true` on without one. An app with no tracer makes no span and costs nothing, and tracing doesn't change what the game does.

**Breaking**: `System.withSpan` is gone: a game that wrapped its systems with it provides a tracer, which traces every system. A program that already provides a tracer now gets a span for every system on every tick, and sets `trace: false` if it doesn't want them.
