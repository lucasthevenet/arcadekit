import { Schema } from "effect";

import type { AudioSystem } from "./system";

// The player's volume and mute: their shape, what they are before the player changes anything,
// and how an audio system takes them. An app keeps them between sessions with a `Setting`
// (`arcadekit/save`), under its own storage key, apart from its save (ADR-0009).

const Level: Schema.Finite = Schema.Finite.check(
  Schema.isBetween({ minimum: 0, maximum: 1 })
);

/** Volume of each bus (0 to 1) and mute. */
export const AudioSettings: Schema.Struct<{
  readonly master: Schema.Finite;
  readonly sfx: Schema.Finite;
  readonly music: Schema.Finite;
  readonly muted: Schema.Boolean;
}> = Schema.Struct({
  master: Level,
  sfx: Level,
  music: Level,
  muted: Schema.Boolean,
});
export type AudioSettings = typeof AudioSettings.Type;

/** The settings before the player changes anything: the `default` of an app's audio `Setting`. */
export const defaultAudioSettings: AudioSettings = {
  master: 0.8,
  sfx: 0.8,
  music: 0.6,
  muted: false,
};

/** Sets the audio system's bus volumes and mute from `settings`. */
export const applyAudioSettings = (
  audio: AudioSystem,
  settings: AudioSettings
): void => {
  audio.setVolume("master", settings.master);
  audio.setVolume("sfx", settings.sfx);
  audio.setVolume("music", settings.music);
  audio.setMuted(settings.muted);
};
