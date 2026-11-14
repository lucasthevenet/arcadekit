# Audio

A game plays its sounds through an `AudioSystem.AudioSystem`, the service an app provides: `BrowserAudioSystem.layer` (`arcadekit/audio/browser`) over Web Audio, or `AudioSystem.layerSilent`, which plays nothing. It plays one-shots with pitch and volume jitter, a voice cap and a minimum gap per sound, loops held from state, and music with crossfades, on master, sfx and music buses with mute and ducking. It stays silent until the player's first gesture and while the tab is hidden.

## Loading and playing

A racing game loads its sounds once at startup, starts the music and plays a click:

```ts
import { AudioSystem } from "arcadekit/audio";
import { BrowserAudioSystem } from "arcadekit/audio/browser";
import { Effect } from "effect";

const SOUNDS = {
  engine: { file: "/sounds/engine.wav", pitchJitter: 0.06, volumeJitter: 0.2 },
  click: { file: "/sounds/click.wav", pitchJitter: 0.05 },
  music: { file: "/sounds/music.wav", bus: "music" },
} satisfies AudioSystem.SoundList;

export const loadSounds = Effect.gen(function* () {
  const audio = yield* AudioSystem.AudioSystem;
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
}).pipe(Effect.provide(BrowserAudioSystem.layer));
```

`load` decodes each file once, even when two loads of it overlap, and tries a file that failed (or whose every load was interrupted) again on the next load, so an app can retry after an `AudioLoadError`. A trace shows each load as `AudioSystem.load`. Playing never waits on it: a sound not yet loaded is dropped. Every call but `load` is plain and never throws, so a sound view plays during its `render`.

`BrowserAudioSystem.layer` makes no `AudioContext` until the player's first pointer, key or touch gesture that lets audio start, and silences everything while the tab is hidden. When its scope closes it stops listening, stops every sound and closes the context. In a browser without Web Audio it provides `AudioSystem.silent`.

## A cue table

A game's view plays its sounds from cue counters in the state. A genre's views name their cues and ship no sound, so a genre declares a `CueTable`: its cues by name, each with the Schema of what the app gives for it (`AudioSystem.SoundId`, a sound id of the app's sound list). The app gives the table its sounds, and the genre's sound view plays from them:

```ts
import { AudioSystem, CueTable } from "arcadekit/audio";
import type { CueSoundsOf } from "arcadekit/audio";
import { Effect, Layer } from "effect";

// The genre declares its cues, and ships no sound.
export class RaceCueTable extends CueTable("RaceCueTable", {
  cues: {
    /** A car crossing the line. */
    lap: AudioSystem.SoundId,
    /** Two cars touching. */
    bump: AudioSystem.SoundId,
    /** Loops while the engine runs. */
    engine: AudioSystem.SoundId,
  },
}) {}

// Its sound view takes the sounds beside the audio system.
export const playLap = (
  audio: AudioSystem.AudioSystem,
  sounds: CueSoundsOf<typeof RaceCueTable>
): void => audio.play(sounds.lap);

// The app says which sound of its sound list each cue plays.
export const RaceCueTableLayer = RaceCueTable.layer({
  lap: "bell",
  bump: "crunch",
  engine: "engine-loop",
});

// And whatever plays them reads both. A `Game.Engine` names them in `uses`:
// `uses: { audio: AudioSystem.AudioSystem, sounds: RaceCueTable }`.
export const lap = Effect.gen(function* () {
  playLap(yield* AudioSystem.AudioSystem, yield* RaceCueTable);
}).pipe(
  Effect.provide(Layer.mergeAll(RaceCueTableLayer, AudioSystem.layerSilent))
);
```

A cue the app leaves out, and a sound for a name that is no cue, are type errors in a table written in place or annotated with `CueSoundsOf<typeof RaceCueTable>`, and `layer` throws for one that got past the types. A sound id stays a string, as `play` takes it. An app can check its table against its own sound list with `satisfies Record<string, keyof typeof SOUNDS>`, if the list keeps its keys: written `const SOUNDS = { ... } satisfies AudioSystem.SoundList`, as above. One annotated `: AudioSystem.SoundList` has every string for a key, and the check then refuses nothing. A game that keeps its sounds beside its rules needs no cue table: its view takes a plain object.

## The audio settings

The player's volume and mute are `AudioSettings.AudioSettings`, with `AudioSettings.defaults` before they change anything and `AudioSystem.applySettings` to set them. An app keeps them between sessions with a [`Setting`](saves.md), under its own storage key:

```ts
import { AudioSettings, AudioSystem } from "arcadekit/audio";
import { Setting } from "arcadekit/save";
import { Effect } from "effect";

export class RaceAudioSettings extends Setting("RaceAudioSettings", {
  storageKey: "my-studio/race/settings",
  schema: AudioSettings.AudioSettings,
  default: AudioSettings.defaults,
}) {}

// At startup, the stored settings are read and applied.
export const applyStored = Effect.gen(function* () {
  const settings = yield* (yield* RaceAudioSettings).read;
  AudioSystem.applySettings(yield* AudioSystem.AudioSystem, settings);
});
```

## In a test

A test of a game's sound view gives it an audio system that records what it is asked to play, and a test that only needs one to exist provides `AudioSystem.layerSilent`. `AudioSystem.make` takes the calls a test cares about; each one it isn't given does nothing, and a `load` it isn't given succeeds:

```ts
import { AudioSystem } from "arcadekit/audio";

const played: string[] = [];
export const audio = AudioSystem.make({
  play: (id) => {
    played.push(id);
  },
});
```

A test of what plays, rather than what is asked for, makes the mixer itself: `AudioMixer.make` decodes through the function it is given, and `AudioMixer.unlock` starts it playing into an `AudioMixer.Output`, such as a fake one that records each voice it starts. The scope `AudioMixer.make` runs in stops its voices when it closes.
