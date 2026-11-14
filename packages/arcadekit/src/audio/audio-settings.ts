/**
 * Audio settings: the player's volume of each bus and their mute, as a Schema, and what they are
 * before the player changes anything.
 *
 * An app keeps them between sessions with a `Setting` (`arcadekit/save`), under its own storage
 * key, apart from its save, where the last write wins: its `schema` is
 * `AudioSettings.AudioSettings` and its `default` is `AudioSettings.defaults`. An audio system takes
 * them with `AudioSystem.applySettings`. They are data, plain as Effect's own Schemas are.
 *
 * @since 0.7.0
 */
import { Schema } from "effect";

const Level: Schema.Finite = Schema.Finite.check(
  Schema.isBetween({ minimum: 0, maximum: 1 })
);

/**
 * The player's audio settings, as a Schema: a volume from 0 to 1 for each bus, and whether
 * everything is muted.
 *
 * **When to use**
 *
 * As the `schema` of an app's audio `Setting`, and wherever its Model or a Message holds the
 * settings.
 *
 * **Details**
 *
 * A volume outside 0 to 1, or one that isn't finite, is refused, so a stored value that was
 * tampered with reads as the setting's `default`.
 *
 * **Example** (Checking settings)
 *
 * ```ts
 * import { AudioSettings } from "arcadekit/audio";
 * import { Schema } from "effect";
 *
 * const isSettings = Schema.is(AudioSettings.AudioSettings);
 * isSettings({ master: 1, sfx: 0.5, music: 0, muted: false }); // => true
 * isSettings({ master: 2, sfx: 0.5, music: 0, muted: false }); // => false
 * ```
 *
 * @category schemas
 * @since 0.7.0
 */
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

/**
 * The player's audio settings: a volume from 0 to 1 for each bus, and whether everything is muted.
 *
 * **When to use**
 *
 * To type what an options screen shows and changes, and what `AudioSystem.applySettings` takes.
 *
 * **Example** (Muting)
 *
 * ```ts
 * import { AudioSettings } from "arcadekit/audio";
 *
 * const mute = (settings: AudioSettings.AudioSettings): AudioSettings.AudioSettings => ({
 *   ...settings,
 *   muted: true,
 * });
 * mute(AudioSettings.defaults).muted; // => true
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type AudioSettings = typeof AudioSettings.Type;

/**
 * The audio settings before the player changes anything.
 *
 * **When to use**
 *
 * As the `default` of an app's audio `Setting`, which a missing or unreadable stored value reads
 * as, and as the Model's settings before they are read. An app may start from it:
 * `{ ...AudioSettings.defaults, music: 0.4 }`.
 *
 * **Example** (The defaults)
 *
 * ```ts
 * import { AudioSettings } from "arcadekit/audio";
 *
 * AudioSettings.defaults; // => { master: 0.8, sfx: 0.8, music: 0.6, muted: false }
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export const defaults: AudioSettings = {
  master: 0.8,
  sfx: 0.8,
  music: 0.6,
  muted: false,
};
