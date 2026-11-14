/**
 * The player's volume and mute, declared: an app setting, kept apart from the save.
 */
import { AudioSettings } from "arcadekit/audio";
import { Setting } from "arcadekit/save";

/**
 * The player's volume and mute, kept under their own storage key, where the last write wins.
 * `LoadAudioSettings` reads them at startup and applies them, and the sound panel writes them.
 */
export class PushPuzzleAudioSettings extends Setting(
  "PushPuzzleAudioSettings",
  {
    storageKey: "arcadekit/push-puzzle/settings",
    schema: AudioSettings.AudioSettings,
    default: AudioSettings.defaults,
  }
) {}
