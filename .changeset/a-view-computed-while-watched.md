---
"arcadekit": minor
---

`View.publish` runs its body only while the UI watches the view: while the view has a listener, and in the frame after the UI reads it with `get`. A view nobody watches costs the game nothing. `View.publish(view, { when }, body)` runs the body again only when what `when` returns changed, compared as data, and publishes the value it last computed otherwise.

**Breaking**

- `ui.get` of a view the UI doesn't listen to returns it a frame late: the frame after the read publishes it. A UI, or a test acting as one, that reads a view after each frame subscribes to it, `ui.subscribe(view, listener)`.
- `View.PortShape.connected` is gone. A frame system of the game's own that checked it asks `(yield* View.Port).watched(view)`, which is false for every view where there is no UI.
