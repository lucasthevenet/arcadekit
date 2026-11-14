import type { SurvivorsCueTable } from "@arcadekit/survivors/browser";
import { AudioSettings } from "arcadekit/audio";
import type { AudioSystem, CueSoundsOf } from "arcadekit/audio";
import { Setting } from "arcadekit/save";

// The game's sounds: the files in public/sounds, the sound each cue of the survivors cue table
// plays, the music and the player's audio settings. Each sound id is its file name without
// `.wav`, so a file can be swapped for a real one with no code change.

const file = (id: string) => `${import.meta.env.BASE_URL}sounds/${id}.wav`;

const sfx = (
  id: string,
  def: Omit<AudioSystem.Sound, "file"> = {}
): AudioSystem.Sound => ({
  file: file(id),
  ...def,
});

const shot = {
  pitchJitter: 0.08,
  volumeJitter: 0.25,
  maxVoices: 4,
  minGapMs: 60,
};

/** Every sound the app loads at startup, by id. */
export const soundList: AudioSystem.SoundList = {
  "shot-arc": sfx("shot-arc", shot),
  "shot-bubble": sfx("shot-bubble", shot),
  hit: sfx("hit", {
    pitchJitter: 0.12,
    volumeJitter: 0.3,
    maxVoices: 4,
    minGapMs: 50,
  }),
  kill: sfx("kill", {
    pitchJitter: 0.1,
    volumeJitter: 0.2,
    maxVoices: 4,
    minGapMs: 60,
  }),
  pickup: sfx("pickup", { pitchJitter: 0.06, maxVoices: 3, minGapMs: 70 }),
  // Contact damage counts every step it lasts, so the gap paces it.
  hurt: sfx("hurt", { pitchJitter: 0.06, maxVoices: 2, minGapMs: 280 }),
  down: sfx("down", { maxVoices: 2 }),
  "level-up": sfx("level-up", { maxVoices: 1 }),
  won: sfx("won", { maxVoices: 1 }),
  lost: sfx("lost", { maxVoices: 1 }),
  "aura-hum": sfx("aura-hum"),
  click: sfx("click", { pitchJitter: 0.04, maxVoices: 2 }),
  "music-menu": { file: file("music-menu"), bus: "music" },
  "music-run": { file: file("music-run"), bus: "music" },
};

/** Which sound each survivors cue plays. A weapon's `sound` in weapons.json overrides `shot`. */
export const survivorsSounds: CueSoundsOf<typeof SurvivorsCueTable> = {
  shot: "shot-arc",
  hit: "hit",
  kill: "kill",
  pickup: "pickup",
  hurt: "hurt",
  down: "down",
  levelUp: "level-up",
  won: "won",
  lost: "lost",
  auraHum: "aura-hum",
};

/** Menu buttons and upgrade picks. */
export const CLICK_SOUND = "click";

/** The music on the menus and during a run. Starting or ending a run crossfades between them. */
export const MUSIC = { menu: "music-menu", run: "music-run" } as const;

/** The player's volume and mute: app settings, kept apart from the save, where the last write wins (ADR-0009). */
export class SurvivorsAudioSettings extends Setting("SurvivorsAudioSettings", {
  storageKey: "arcadekit/survivors/settings",
  schema: AudioSettings.AudioSettings,
  default: AudioSettings.defaults,
}) {}
