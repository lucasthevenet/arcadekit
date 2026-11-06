# @arcadekit/audio

Sound for a game: one-shots with pitch and volume jitter, a voice cap and minimum gap per sound, loops held from state, music with crossfades, master, sfx and music buses, mute and ducking. It stays silent until the player's first gesture and while the tab is hidden. `Audio` is the Effect service; `BrowserAudioLayer` in `@arcadekit/audio/browser` provides it over Web Audio, and `SilentAudioLayer` plays nothing, for tests. `makeAudioSettingsStore` keeps the player's volumes and mute.

Part of [arcadekit](https://github.com/lucasthevenet/arcadekit#readme). The root entry is DOM-free.

## Install

```bash
pnpm add @arcadekit/audio effect
```

Peer dependency: `effect` (~4.1). Saving settings needs a `KeyValueStore`, such as `BrowserSaveStorage` from `@arcadekit/save/browser`.

## Example

Load the sounds once at startup, start the music, and play a click (from the push-puzzle demo):

```ts
import { Audio } from "@arcadekit/audio";
import type { SoundList } from "@arcadekit/audio";
import { BrowserAudioLayer } from "@arcadekit/audio/browser";
import { Effect } from "effect";

const SOUNDS: SoundList = {
  move: { file: "/sounds/move.wav", pitchJitter: 0.06, volumeJitter: 0.2 },
  click: { file: "/sounds/click.wav", pitchJitter: 0.05 },
  music: { file: "/sounds/music.wav", bus: "music" },
};

export const loadSounds = Effect.gen(function* () {
  const audio = yield* Audio;
  audio.playMusic("music"); // heard once it has loaded and the player has clicked or pressed a key
  yield* audio
    .load(SOUNDS)
    .pipe(
      Effect.catchTag("AudioLoadError", (error) =>
        Effect.logWarning(
          "A sound can't be loaded. Play goes on without it.",
          error.message
        )
      )
    );
  audio.play("click");
}).pipe(Effect.provide(BrowserAudioLayer));
```

`load` decodes each file once, even when two loads of it overlap, and tries a file that failed (or whose every load was interrupted) again on the next load, so an app can retry after an `AudioLoadError`. Playing never waits on it: a sound not yet loaded is dropped.

`makeAudioMixer` makes the mixer behind `Audio`. It plays into whatever `AudioOutput` it is unlocked with, such as a fake one in a test. Making it is an Effect; after that, every call but `load` is plain. `makeBrowserAudio` in `@arcadekit/audio/browser` makes it over Web Audio for the life of a scope, and `BrowserAudioLayer` is built on it.

A game's view plays its sounds from cue counters in the state, as [ADR-0014](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0014-sounds-come-from-cue-counters-read-by-the-presentation.md) describes.
