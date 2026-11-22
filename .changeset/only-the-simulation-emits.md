---
"arcadekit": minor
---

An event is emitted by the simulation alone: a system of the tick, an action's handler or a plugin's setup. `app.events.emit()` and a handle's `emit` throw from anywhere else, where they added an event that no log held, so that a replay of the game and its other peers went on without it.

What the frame and input stages hear is a module of its own, `arcadekit/Outbox`, where it was part of `Event`.

**Breaking**

- `app.events.emit(event, payload)` from outside the simulation throws. Dispatch or enqueue an action whose handler emits the event.
- A handle a system kept, used once the system has run, throws on `emit`.
