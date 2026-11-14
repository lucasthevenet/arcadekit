# arcadekit/audio

Sound for a game: one-shots with pitch and volume jitter, a voice cap and minimum gap per sound, loops held from state, music with crossfades, master, sfx and music buses, mute and ducking. It stays silent until the player's first gesture and while the tab is hidden. `AudioSystem.AudioSystem` is what a game plays through, and the key of the service an app provides: `BrowserAudioSystem.layer` in `arcadekit/audio/browser` over Web Audio, or `AudioSystem.layerSilent`, which plays nothing, for tests. `CueTable` declares a genre's cues, for the app to say which of its sounds each plays. `AudioSettings.AudioSettings` is the shape of the player's volumes and mute, which an app keeps with a `Setting`. Behind the browser's audio system is an `AudioMixer.AudioMixer`, which plays into whatever output its host unlocks it with.

An entry of the [`arcadekit`](../../README.md) package. The root entry is DOM-free.

## Install

```bash
pnpm add arcadekit effect
```

Peer dependency: `effect` (~4.1).

## Its modules

| Entry | Export | What it holds | Guide |
| --- | --- | --- | --- |
| `arcadekit/audio` | [`AudioSystem`](audio-system.ts) | What a game plays through and the key of its service, with `layerSilent`, `make` for a test's, and `applySettings` | [Audio](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/audio.md) |
| `arcadekit/audio` | `CueTable` | A genre's cues, declared for the app to say which of its sounds each plays | [Audio](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/audio.md#a-cue-table) |
| `arcadekit/audio` | [`AudioSettings`](audio-settings.ts) | The Schema of the player's volumes and mute, and their defaults | [Audio](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/audio.md#the-audio-settings) |
| `arcadekit/audio` | [`AudioMixer`](audio-mixer.ts) | The mixer behind the browser's audio system, which plays into whatever output its host unlocks it with | [Audio](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/audio.md#in-a-test) |
| `arcadekit/audio/browser` | [`BrowserAudioSystem`](browser/browser-audio-system.ts) | `BrowserAudioSystem.layer`, the audio system over Web Audio | [Audio](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/audio.md) |

## Example

A game loads its sounds once and plays a click:

```ts
import { AudioSystem } from "arcadekit/audio";
import { BrowserAudioSystem } from "arcadekit/audio/browser";
import { Effect } from "effect";

const SOUNDS = {
  click: { file: "/sounds/click.wav", pitchJitter: 0.05 },
} satisfies AudioSystem.SoundList;

export const click = Effect.gen(function* () {
  const audio = yield* AudioSystem.AudioSystem;
  yield* audio.load(SOUNDS);
  audio.play("click");
}).pipe(Effect.provide(BrowserAudioSystem.layer));
```
