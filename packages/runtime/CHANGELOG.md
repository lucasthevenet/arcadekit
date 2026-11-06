# @arcadekit/runtime

## 0.2.0

### Minor Changes

- [#51](https://github.com/lucasthevenet/arcadekit/pull/51) [`f46fda2`](https://github.com/lucasthevenet/arcadekit/commit/f46fda2ce4865cfd3c6d53b872d4e31e6d190801) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `GameEngine.attach` now fails with a typed `AttachError` (exported from `@arcadekit/runtime/browser`, with the thrown `cause`) when `createView` or `createInput` throws, such as Three.js finding no WebGL, instead of dying. Its new type, `(element) => Effect<never, AttachError | GameCrashed>`, is in the frame loop entry. Nothing is left attached: a view made before `createInput` threw is disposed, and a throwing `dispose` still disposes the view and lets the engine attach again. `makeEngineLoader` now frees the assets of a load whose `game` throws.

  `engineEntry` hands an attach failure to `onError`, so the app gets a Message instead of a blank viewport. `EngineEntryConfig` takes a sixth type parameter, `A`, for what `attach` fails with, and `onError` receives `E | A`.

  `AudioSystem.load` now decodes a file once when two loads of it overlap.

  Breaking:

  - `engineEntry` with a `GameEngine` (or `engineOf(loader)`) now requires `onError`, which also receives `AttachError`. An entry for a plain `GameEngine` that had no `onError` must add one.
  - `EngineEntryConfig<Model, Message, Event, R, E>` is now `EngineEntryConfig<Model, Message, Event, R, E, A>`; `engine` is `Effect<AttachableEngine<Event, A>, E, R>`.

- [#52](https://github.com/lucasthevenet/arcadekit/pull/52) [`faebbf6`](https://github.com/lucasthevenet/arcadekit/commit/faebbf67e4237cce060a6727dae620400a8657f2) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The browser frame loop is an Effect now. `GameEngine.attach(element)` makes the view and the input source, then runs the frame loop itself for as long as it stays attached: each frame waits for the next animation frame, steps the run, then draws, all in one go. A frame whose step, render or event listener throws is the last one: the run ends, the loop asks for no more frames, the view and input source are disposed, and `attach` fails with the new `GameCrashed` (exported from `@arcadekit/runtime/browser`, with the thrown `cause`). Before, the loop kept running after a throw and nothing on the Effect side was told. The first frame no longer steps by a negative time when `requestAnimationFrame`'s time is before attach.

  `engineEntry` runs `attach` instead of waiting forever after it, so a crash reaches `onError` as a Message, sent once, like a failed attach.

  Breaking:

  - `GameEngine.attach` is `(element) => Effect<never, AttachError | GameCrashed>` (was `Effect<void, never, Scope>`). It runs until interrupted instead of returning once attached, and it needs no `Scope`. Interrupt it to detach. It fails with `AttachError` when `createView` or `createInput` throws, and with `GameCrashed` when a frame throws. It never succeeds, so run it last: start the run, then `return yield* engine.attach(element)`. Its failures reach only what waits on it: a forked `attach` that nothing joins (`Effect.forkScoped(engine.attach(element))` alone) loses them silently, so join its fiber (`Fiber.join`) or race the rest of the program against it (`Effect.raceFirst(rest, engine.attach(element))`).
  - A crash ends the run, as `stop` does: attached again, the engine draws no run until the app starts a new one. Before, the run stayed live after a throw, and the next frame ran the step that threw again.
  - `AttachableEngine<Event, E>.attach` is `(element) => Effect<never, E>` (was `Effect<void, E, Scope>`): it runs until interrupted, and fails with `E` if it can't attach or stops on its own. An engine that draws on its own timer ends its `attach` with `Effect.never`, scoped.
  - `onError` in `engineEntry` for a `GameEngine` (or `engineOf(loader)`) also receives `GameCrashed`.
  - `GameDriver` is removed from `@arcadekit/runtime/browser`. Use `makeGameEngine` to step and draw in the browser, or `GameLoop` to step without drawing.

### Patch Changes

- Updated dependencies []:
  - @arcadekit/core@0.2.0

## 0.1.0

### Minor Changes

- [#48](https://github.com/lucasthevenet/arcadekit/pull/48) [`36fedda`](https://github.com/lucasthevenet/arcadekit/commit/36feddaaf0af8bc3218d7b8127b0b2f6505f54aa) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - First release.

### Patch Changes

- Updated dependencies [[`36fedda`](https://github.com/lucasthevenet/arcadekit/commit/36feddaaf0af8bc3218d7b8127b0b2f6505f54aa)]:
  - @arcadekit/core@0.1.0
