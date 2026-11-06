---
"@arcadekit/runtime": minor
"@arcadekit/foldkit": minor
"@arcadekit/audio": minor
---

`GameEngine.attach` now fails with a typed `AttachError` (exported from `@arcadekit/runtime/browser`, with the thrown `cause`) when `createView` or `createInput` throws, such as Three.js finding no WebGL, instead of dying. Nothing is left attached: a view made before `createInput` threw is disposed, and a throwing `dispose` still disposes the view and lets the engine attach again. `makeEngineLoader` now frees the assets of a load whose `game` throws.

`engineEntry` hands an attach failure to `onError`, so the app gets a Message instead of a blank viewport. `EngineEntryConfig` takes a sixth type parameter, `A`, for what `attach` fails with, and `onError` receives `E | A`.

`AudioSystem.load` now decodes a file once when two loads of it overlap.

Breaking:

- `GameEngine.attach` is `Effect<void, AttachError, Scope>` (was `Effect<void, never, Scope>`). Callers that yield it must handle or pass on `AttachError`.
- `engineEntry` with a `GameEngine` (or `engineOf(loader)`) now requires `onError`, which also receives `AttachError`. An entry for a plain `GameEngine` that had no `onError` must add one.
- `EngineEntryConfig<Model, Message, Event, R, E>` is now `EngineEntryConfig<Model, Message, Event, R, E, A>`; `engine` is `Effect<AttachableEngine<Event, A>, E, R>`.
