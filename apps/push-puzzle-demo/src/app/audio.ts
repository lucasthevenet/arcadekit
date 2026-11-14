import type { PushPuzzleCueTable } from "@arcadekit/push-puzzle/browser";
import { AudioSettings } from "arcadekit/audio";
import type { AudioSystem, CueSoundsOf } from "arcadekit/audio";
import { Setting } from "arcadekit/save";

// This game's sounds: the files it ships, which sound each cue plays, and where the
// player's volume and mute are kept. The files are in public/sounds; each id is its file name.

const file = (id: string) => `${import.meta.env.BASE_URL}sounds/${id}.wav`;

/** The sound played when a menu button is pressed. */
export const CLICK = "click";
/** The music loop, playing from startup. */
export const MUSIC = "music";

export const SOUND_LIST: AudioSystem.SoundList = {
  move: { file: file("move"), pitchJitter: 0.06, volumeJitter: 0.2 },
  push: { file: file("push"), pitchJitter: 0.05, volumeJitter: 0.15 },
  hole: { file: file("hole") },
  undo: { file: file("undo"), pitchJitter: 0.04 },
  solved: { file: file("solved"), maxVoices: 1 },
  [CLICK]: { file: file(CLICK), pitchJitter: 0.05 },
  [MUSIC]: { file: file(MUSIC), bus: "music" },
};

/** Which sound each push-puzzle cue plays. */
export const CUE_SOUNDS: CueSoundsOf<typeof PushPuzzleCueTable> = {
  move: "move",
  push: "push",
  hole: "hole",
  undo: "undo",
  solved: "solved",
};

/** The player's volume and mute: app settings, kept apart from the save, where the last write wins (ADR-0009). */
export class PushPuzzleAudioSettings extends Setting(
  "PushPuzzleAudioSettings",
  {
    storageKey: "arcadekit/push-puzzle/settings",
    schema: AudioSettings.AudioSettings,
    default: AudioSettings.defaults,
  }
) {}

/** A volume from a slider, kept within 0 to 1. Anything unreadable is 0. */
export const toVolume = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

export type Bus = "master" | "sfx" | "music";

export const withVolume = (
  settings: AudioSettings.AudioSettings,
  bus: Bus,
  value: number
): AudioSettings.AudioSettings => ({ ...settings, [bus]: toVolume(value) });
