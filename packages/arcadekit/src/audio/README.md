# arcadekit/audio

Sound for a game: one-shots with pitch and volume jitter, a voice cap and minimum gap per sound, loops held from state, music with crossfades, master, sfx and music buses, mute and ducking. It stays silent until the player's first gesture and while the tab is hidden. `Audio` is the Effect service; `BrowserAudioLayer` in `arcadekit/audio/browser` provides it over Web Audio, and `SilentAudioLayer` plays nothing, for tests. `CueTable` declares a genre's cues, for the app to say which of its sounds each plays. `AudioSettings` is the shape of the player's volumes and mute, which an app keeps with a `Setting`.

An entry of the [`arcadekit`](../../README.md) package. The root entry is DOM-free.

## Install

```bash
pnpm add arcadekit effect
```

Peer dependency: `effect` (~4.1).

## Example

Load the sounds once at startup, start the music, and play a click (from the push-puzzle demo):

```ts
import { Audio } from "arcadekit/audio";
import type { SoundList } from "arcadekit/audio";
import { BrowserAudioLayer } from "arcadekit/audio/browser";
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

`makeAudioMixer` makes the mixer behind `Audio`. It plays into whatever `AudioOutput` it is unlocked with, such as a fake one in a test. Making it is an Effect; after that, every call but `load` is plain. `makeBrowserAudio` in `arcadekit/audio/browser` makes it over Web Audio for the life of a scope, and `BrowserAudioLayer` is built on it.

## A cue table

A game's view plays its sounds from cue counters in the state, as [ADR-0014](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0014-sounds-come-from-cue-counters-read-by-the-presentation.md) describes. A genre package ships no sound, so it declares a `CueTable`: its cues by name, each with the Schema of what the app gives for it (`SoundId`, a sound id of the app's sound list). The app gives the table its sounds, and the genre's sound view plays from them:

```ts
import { Audio, CueTable, SilentAudioLayer, SoundId } from "arcadekit/audio";
import type { AudioSystem, CueSoundsOf } from "arcadekit/audio";
import { Effect, Layer } from "effect";

// The genre declares its cues, and ships no sound.
export class RaceCueTable extends CueTable("RaceCueTable", {
  cues: {
    /** A car crossing the line. */
    lap: SoundId,
    /** Two cars touching. */
    bump: SoundId,
    /** Loops while the engine runs. */
    engine: SoundId,
  },
}) {}

// Its sound view takes the sounds beside the audio system.
export const playLap = (
  audio: AudioSystem,
  sounds: CueSoundsOf<typeof RaceCueTable>
): void => audio.play(sounds.lap);

// The app says which sound of its sound list each cue plays.
export const RaceSounds = RaceCueTable.layer({
  lap: "bell",
  bump: "crunch",
  engine: "engine-loop",
});

// And whatever plays them reads both. A `Game.Engine` names them in `uses`:
// `uses: { audio: Audio, sounds: RaceCueTable }`.
export const lap = Effect.gen(function* () {
  playLap(yield* Audio, yield* RaceCueTable);
}).pipe(Effect.provide(Layer.mergeAll(RaceSounds, SilentAudioLayer)));
```

A cue the app leaves out, and a sound for a name that is no cue, are type errors in a table written in place or annotated with `CueSoundsOf<typeof RaceCueTable>`, and `layer` throws for one that got past the types. A sound id stays a string, as `audio.play` takes it; an app can check its table against its own sound list with `satisfies Record<string, keyof typeof SOUNDS>`. A game that keeps its sounds beside its rules needs no cue table: its view takes a plain object.

## The audio settings

The player's volume and mute are `AudioSettings`, with `defaultAudioSettings` before they change anything and `applyAudioSettings(audio, settings)` to set them. An app keeps them between sessions with a [`Setting`](../save/README.md), under its own storage key: `schema: AudioSettings, default: defaultAudioSettings`.
