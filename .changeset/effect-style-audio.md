---
"arcadekit": minor
---

`arcadekit/audio` is written as Effect's modules are. `CueTable` keeps its builder, and a genre declares a cue table as before, with `AudioSystem.SoundId` for each cue. What a game plays through is the namespace `AudioSystem`: `AudioSystem.AudioSystem` is the audio system's type, a value with a `TypeId`, and the key of the service an app provides, as Effect's `KeyValueStore` is a store's. The mixer behind the browser's is `AudioMixer`, the player's settings are `AudioSettings`, and the browser's audio system is `BrowserAudioSystem.layer` in `arcadekit/audio/browser`. **Breaking**: every export but `CueTable` and its types moved into a namespace, and `makeAudioMixer` and `makeBrowserAudio` are gone.

A sound plays, loops, fades, ducks and is dropped as it was, and `load` decodes and fails as it did, with the same messages. What changed besides the names:

- **A test makes an audio system with `AudioSystem.make`.** It takes the calls the test cares about, and each one it isn't given does nothing, where a test spread `silentAudio` into an object of its own. `AudioSystem.isAudioSystem` tells one from a look-alike.
- **A mixer lives as long as its scope.** `AudioMixer.make` is scoped and stops every voice when its scope closes, where `mixer.dispose()` did; a mixer whose scope has closed can't be unlocked again. Its jitter comes from Effect's `Random`, read once when it is made, so `random` is no option: a test provides its own `Random`.
- **Loads are traced** as `AudioSystem.load`, whichever audio system runs them.
- **The browser's decode fails a response that isn't a success with an `AudioLoadError`** naming its status, rather than throwing inside the promise, and the browser's layer waits for its AudioContext to close when its scope closes.
- **`AudioLoadError` is a `Schema.TaggedError`**, with the same tag and fields, so `Effect.catchTag("AudioLoadError", ...)` is as it was.

```ts
import { AudioSettings, AudioSystem, CueTable } from "arcadekit/audio";
import type { CueSoundsOf } from "arcadekit/audio";
import { BrowserAudioSystem } from "arcadekit/audio/browser";
import { Setting } from "arcadekit/save";
import { Effect, Layer } from "effect";

// Before: lap: SoundId
export class RaceCueTable extends CueTable("RaceCueTable", {
  cues: { lap: AudioSystem.SoundId },
}) {}

// Before: (audio: AudioSystem, sounds: ...) => audio.play(sounds.lap)
export const playLap = (
  audio: AudioSystem.AudioSystem,
  sounds: CueSoundsOf<typeof RaceCueTable>
): void => audio.play(sounds.lap);

// Before: schema: AudioSettings, default: defaultAudioSettings
export class RaceAudioSettings extends Setting("RaceAudioSettings", {
  storageKey: "my-studio/race/settings",
  schema: AudioSettings.AudioSettings,
  default: AudioSettings.defaults,
}) {}

// Before: applyAudioSettings(yield* Audio, settings), and Layer.provide(BrowserAudioLayer)
export const applyStored = Effect.gen(function* () {
  const settings = yield* (yield* RaceAudioSettings).read;
  AudioSystem.applySettings(yield* AudioSystem.AudioSystem, settings);
});

// Before: { ...silentAudio, play: (id) => played.push(id) }, and Layer.succeed(Audio, audio)
const played: string[] = [];
export const recording = Layer.succeed(
  AudioSystem.AudioSystem,
  AudioSystem.make({ play: (id) => played.push(id) })
);
export const appAudio = BrowserAudioSystem.layer;
```

**Breaking**

Every export of `arcadekit/audio` and `arcadekit/audio/browser` before, and what a game writes now:

| Before | Now |
| --- | --- |
| `Audio`, a service class keyed `arcadekit/audio/Audio` | `AudioSystem.AudioSystem`, keyed `arcadekit/audio/AudioSystem` (`uses: { audio: AudioSystem.AudioSystem }`, `yield* AudioSystem.AudioSystem`) |
| `AudioSystem`, an interface | `AudioSystem.AudioSystem`, the same key's type, with a `TypeId` |
| an object of a test's own as an audio system | `AudioSystem.make({ ... })`, which `AudioSystem.isAudioSystem` recognises |
| `silentAudio` | `AudioSystem.silent` |
| `SilentAudioLayer` | `AudioSystem.layerSilent` |
| `applyAudioSettings(audio, settings)` | `AudioSystem.applySettings(audio, settings)`, or `audio.pipe(AudioSystem.applySettings(settings))` |
| `AudioBus`, `SoundDef`, `SoundList` | `AudioSystem.Bus`, `AudioSystem.Sound`, `AudioSystem.SoundList` |
| `SoundId` | `AudioSystem.SoundId` |
| `AudioLoadError`, a `Data.TaggedError` | `AudioSystem.AudioLoadError`, a `Schema.TaggedError` with the same tag and fields |
| `AudioSettings`, a Schema and its type | `AudioSettings.AudioSettings`, a Schema and its type |
| `defaultAudioSettings` | `AudioSettings.defaults` |
| `makeAudioMixer({ decode, random, duckedMusic })`, an `Effect<AudioMixer>` | `AudioMixer.make({ decode, duckedMusic })`, an `Effect<AudioMixer.AudioMixer, never, Scope>`; its jitter comes from Effect's `Random` |
| `AudioMixer`, an `AudioSystem` with `unlock`, `setHidden` and `dispose` | `AudioMixer.AudioMixer`, whose `system` is its audio system; `AudioMixer.unlock(mixer, output)`, `AudioMixer.setHidden(mixer, hidden)`, and its scope in place of `dispose()` |
| `AudioMixerOptions`, `AudioOutput`, `AudioGain`, `AudioVoice`, `AudioClip` | `AudioMixer.Options`, `AudioMixer.Output`, `AudioMixer.Gain`, `AudioMixer.Voice`, `AudioMixer.Clip` |
| `makeBrowserAudio` (`arcadekit/audio/browser`) | gone: `BrowserAudioSystem.layer` is the browser's audio system |
| `BrowserAudioLayer` (`arcadekit/audio/browser`) | `BrowserAudioSystem.layer` (`arcadekit/audio/browser`) |

`CueTable`, `CueTableClass`, `CueTableDefinition`, `CueTableId`, `CueTableService`, `AnyCueTable`, `CueSounds` and `CueSoundsOf` keep their names, and so do a cue table's `kind`, `cueTableName`, `cues` and `layer`, and an audio system's `play`, `setLoop`, `playMusic`, `setVolume`, `setMuted`, `setDucked` and `load`.
