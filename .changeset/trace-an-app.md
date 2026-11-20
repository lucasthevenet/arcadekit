---
"arcadekit": minor
---

An app traces itself when the program provides a tracer: it sends what it does as spans at the "Debug" level, one for each tick, holding a span for each action applied in it and for each system's turn, and one for each run of the frame stage and of the input stage, holding their systems'. It makes none, and costs nothing, when no tracer is provided, under `Effect.withTracerEnabled(false)`, or when `Tracer.MinimumTraceLevel` is above "Debug". Tracing doesn't change what the game does.

**Breaking**: `System.withSpan` is gone: a game that wrapped its systems with it provides a tracer, which traces every system. A program that already provides a tracer now gets a span for every system on every tick, and provides `Tracer.MinimumTraceLevel` as "Info" if it wants only its own.
