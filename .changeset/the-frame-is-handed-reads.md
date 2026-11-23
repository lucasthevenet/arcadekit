---
"arcadekit": minor
---

The frame stage, the input stage and `app.read` are handed a world with no `set`, events with no `emit`, and no `Commands`, each an object of its own. A cast in those places finds nothing to call, where before it reached a run-time refusal of the frozen world. The tick is handed what it was.

**Breaking**

- The `World` service is a `ReadingWorld`, which has no `set`. A system of the tick sets a component with `yield* World.writes(...)`, as before.
- The `Events` service is the new `Event.ReadingEvents`, which has `handle` and no `emit`. A system of the tick emits with `yield* SomeEvent.emits`. One that held `yield* Events` to call `emit` narrows it with `instanceof Event.EventBus` first.
- `app.read(World)` is no longer the same object as the `yield* World` of a system.
