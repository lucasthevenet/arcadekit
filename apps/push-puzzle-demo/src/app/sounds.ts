/**
 * The app's sounds: the files it ships, which of them each of the genre's cues plays, and the
 * volume a slider sets.
 *
 * The files are in `public/sounds`, and each sound's id is its file name. Where the player's
 * volume and mute are kept is `PushPuzzleAudioSettings`.
 *
 * Plain on purpose: data, and the pure functions `update` calls.
 */
import type { AudioSettings, AudioSystem, CueSoundsOf } from "arcadekit/audio";

import type { PushPuzzleCueTable } from "../push-puzzle/browser/index";

const file = (id: string) => `${import.meta.env.BASE_URL}sounds/${id}.wav`;

/** The sound a menu button plays when it is pressed. */
export const click = "click";

/** The music loop, playing from startup. */
export const music = "music";

/** Every sound the app loads, by id: what `LoadSounds` hands the audio system. */
export const list: AudioSystem.SoundList = {
  move: { file: file("move"), pitchJitter: 0.06, volumeJitter: 0.2 },
  push: { file: file("push"), pitchJitter: 0.05, volumeJitter: 0.15 },
  hole: { file: file("hole") },
  undo: { file: file("undo"), pitchJitter: 0.04 },
  solved: { file: file("solved"), maxVoices: 1 },
  [click]: { file: file(click), pitchJitter: 0.05 },
  [music]: { file: file(music), bus: "music" },
};

/** The sounds the app gives `PushPuzzleCueTable`, by cue: which of its sounds each cue plays. */
export const byCue: CueSoundsOf<typeof PushPuzzleCueTable> = {
  move: "move",
  push: "push",
  hole: "hole",
  undo: "undo",
  solved: "solved",
};

/** A volume from a slider, kept within 0 to 1. Anything unreadable is 0. */
export const toVolume = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/** `self` with the volume of `bus` set from a slider's `value`, kept within 0 to 1. */
export const withVolume = (
  self: AudioSettings.AudioSettings,
  bus: AudioSystem.Bus,
  value: number
): AudioSettings.AudioSettings => ({ ...self, [bus]: toVolume(value) });
