---
"@arcadekit/audio": minor
---

The mixer keeps its decoded files in Effect's `Cache`, so the library no longer runs an Effect of its own to share a decode. `load` behaves as before: a file is decoded once, even when two loads of it overlap, and a file that failed is tried again by the next load.

Breaking:

- `makeAudioMixer(options)` returns `Effect<AudioMixer>` (was `AudioMixer`). Yield it inside your program, or run it where your program starts (`Effect.runSync(makeAudioMixer(options))` in a test).
- `makeBrowserAudio` in `@arcadekit/audio/browser` is `Effect<AudioMixer, never, Scope>` (was a function returning `{ audio, dispose }`). Closing its scope does what `dispose` did: it removes its listeners, stops its sounds and closes the AudioContext. `BrowserAudioLayer` is unchanged.
