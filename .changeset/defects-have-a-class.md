---
"arcadekit": minor
"@arcadekit/three": patch
---

A mistake in how arcadekit is used is thrown as a class of the new `arcadekit/Defect`, and no longer as a plain `Error`: `WrongPhase`, `InvalidDefinition`, `InvalidArgument`, `TakenOver`, `ScopeClosed` and `NotSynchronous`, each with fields that say which mistake it was. A test or a tool matches the class and the fields, and a message can be reworded.

It is still a defect: thrown, or what an Effect dies with, and never in an error channel. Every message is what it was.

This breaks what looked at an error's name or its text form: `error.name` is the class's tag where it was `"Error"`, so `String(error)` begins with `WrongPhase:` where it began with `Error:`. `error instanceof Error` and `error.message` are unchanged.

The storage core, `arcadekit/ecs`, imports no package and throws what it threw.
