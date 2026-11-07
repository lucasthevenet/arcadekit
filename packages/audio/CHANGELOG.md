# @arcadekit/audio

## 0.2.1

No changes in this release.

## 0.2.0

### Minor Changes

- [#52](https://github.com/lucasthevenet/arcadekit/pull/52) [`faebbf6`](https://github.com/lucasthevenet/arcadekit/commit/faebbf67e4237cce060a6727dae620400a8657f2) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The mixer keeps its decoded files in Effect's `Cache`, so the library no longer runs an Effect of its own to share a decode. `load` behaves as before: a file is decoded once, even when two loads of it overlap, and a file that failed is tried again by the next load.

  Breaking:

  - `makeAudioMixer(options)` returns `Effect<AudioMixer>` (was `AudioMixer`). Yield it inside your program, or run it where your program starts (`Effect.runSync(makeAudioMixer(options))` in a test).
  - `makeBrowserAudio` in `@arcadekit/audio/browser` is `Effect<AudioMixer, never, Scope>` (was a function returning `{ audio, dispose }`). Closing its scope does what `dispose` did: it removes its listeners, stops its sounds and closes the AudioContext. `BrowserAudioLayer` is unchanged.

- [#51](https://github.com/lucasthevenet/arcadekit/pull/51) [`f46fda2`](https://github.com/lucasthevenet/arcadekit/commit/f46fda2ce4865cfd3c6d53b872d4e31e6d190801) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `GameEngine.attach` now fails with a typed `AttachError` (exported from `@arcadekit/runtime/browser`, with the thrown `cause`) when `createView` or `createInput` throws, such as Three.js finding no WebGL, instead of dying. Its new type, `(element) => Effect<never, AttachError | GameCrashed>`, is in the frame loop entry. Nothing is left attached: a view made before `createInput` threw is disposed, and a throwing `dispose` still disposes the view and lets the engine attach again. `makeEngineLoader` now frees the assets of a load whose `game` throws.

  `engineEntry` hands an attach failure to `onError`, so the app gets a Message instead of a blank viewport. `EngineEntryConfig` takes a sixth type parameter, `A`, for what `attach` fails with, and `onError` receives `E | A`.

  `AudioSystem.load` now decodes a file once when two loads of it overlap.

  Breaking:

  - `engineEntry` with a `GameEngine` (or `engineOf(loader)`) now requires `onError`, which also receives `AttachError`. An entry for a plain `GameEngine` that had no `onError` must add one.
  - `EngineEntryConfig<Model, Message, Event, R, E>` is now `EngineEntryConfig<Model, Message, Event, R, E, A>`; `engine` is `Effect<AttachableEngine<Event, A>, E, R>`.

## 0.1.0

### Minor Changes

- [#48](https://github.com/lucasthevenet/arcadekit/pull/48) [`36fedda`](https://github.com/lucasthevenet/arcadekit/commit/36feddaaf0af8bc3218d7b8127b0b2f6505f54aa) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - First release.
