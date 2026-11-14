/**
 * The player's volume and mute, declared: an app setting, kept apart from the save.
 */
import { AudioSettings } from "arcadekit/audio";
import { Setting } from "arcadekit/save";

/**
 * The player's volume and mute, kept under their own storage key, where the last write wins.
 * `LoadAudioSettings` reads them at startup, `SaveAudioSettings` writes them whenever the sound
 * panel or the M key changes them, and the `sound` Subscription applies the Model's to the audio
 * system.
 */
export class SurvivorsAudioSettings extends Setting("SurvivorsAudioSettings", {
  storageKey: "arcadekit/survivors/settings",
  schema: AudioSettings.AudioSettings,
  default: AudioSettings.defaults,
}) {}
