import { Effect, Option, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";

import type { AudioSystem } from "./system";

// The player's volume and mute, kept between sessions. They are app settings, not part of a
// save: each app keeps them under their own key, and the last write wins (ADR-0009).

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

/** The settings before the player changes anything, and after a missing or corrupt read. */
export const defaultAudioSettings: AudioSettings = {
  master: 0.8,
  sfx: 0.8,
  music: 0.6,
  muted: false,
};

/** The audio settings over a `KeyValueStore`. Neither method fails: storage problems are logged and play goes on. */
export interface AudioSettingsStore {
  /** The stored settings. Missing, corrupt or unreadable settings read as `defaultAudioSettings`. */
  readonly load: Effect.Effect<AudioSettings>;
  /** Stores `settings`, replacing what is there. A failed write is logged and dropped. */
  readonly save: (settings: AudioSettings) => Effect.Effect<void>;
}

/** Builds the audio settings store under `key`, such as `my-studio/<game>/settings`, over the `KeyValueStore` in context. */
export const makeAudioSettingsStore = (
  key: string
): Effect.Effect<AudioSettingsStore, never, KeyValueStore.KeyValueStore> =>
  Effect.gen(function* () {
    const store = KeyValueStore.toSchemaStore(
      yield* KeyValueStore.KeyValueStore,
      AudioSettings
    );
    return {
      load: store.get(key).pipe(
        Effect.map(Option.getOrElse(() => defaultAudioSettings)),
        Effect.catch((error) =>
          Effect.logWarning(
            "The audio settings can't be read. Play goes on with the defaults.",
            error.message
          ).pipe(Effect.as(defaultAudioSettings))
        )
      ),
      save: (settings) =>
        store
          .set(key, settings)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                "The audio settings can't be written.",
                error.message
              )
            )
          ),
    };
  });

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
