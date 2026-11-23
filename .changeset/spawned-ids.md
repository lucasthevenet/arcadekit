---
"arcadekit": minor
---

`Commands.spawn` returns a `Spawned` id, whose entity is placed when the system or handler that spawned it finishes. The world's reads take an `Entity`, so reading an entity before it exists doesn't compile, where it threw. `Commands`, a component's value, an event's payload and an action a system enqueues take a `Spawned` id, since each is applied or read once the spawn is placed, and `app.dispatch` gives a handler's `Spawned` back as an `Entity`. `world.placed(id)` gives the entity of an id kept past the code that spawned it, and undefined before its spawn is applied.

**Breaking**

- An id from `Commands.spawn` is a `Spawned`, not an `Entity`. Code that keeps one, in a variable a setup fills or in a service, converts it with `world.placed(id)` where it reads the world.
- `CommandBuffer` of `arcadekit/ecs` is `CommandBuffer<Id>`, whose `spawn` returns `Id`, `Entity` by default.
