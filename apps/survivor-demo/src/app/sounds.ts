/**
 * The app's sounds: the files it ships, which of them each of the genre's cues plays, the click
 * and the music.
 *
 * The files are in `public/sounds`, and each sound's id is its file name without `.wav`, so a
 * file can be swapped for a real one with no code change. Where the player's volume and mute are
 * kept is `SurvivorsAudioSettings`.
 *
 * Plain on purpose: it is data.
 */
import type { SurvivorsCueTable } from "@arcadekit/survivors/browser";
import type { AudioSystem, CueSoundsOf } from "arcadekit/audio";

const file = (id: string) => `${import.meta.env.BASE_URL}sounds/${id}.wav`;

/** A sound from the file named for its id, on the `sfx` bus unless `def` names another. */
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

/** The sound a button plays when it is clicked (`PlayClick`): a menu's, a hero's, an upgrade pick's or the mute's. */
export const click = "click";

/**
 * The music, by where it plays: on the menus, and during a run. The audio system crossfades from
 * one to the other as a run starts and ends.
 */
export const music = { menu: "music-menu", run: "music-run" } as const;

/** Every sound the app loads, by id: what `LoadSounds` hands the audio system at startup. */
export const list: AudioSystem.SoundList = {
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
  [click]: sfx(click, { pitchJitter: 0.04, maxVoices: 2 }),
  [music.menu]: { file: file(music.menu), bus: "music" },
  [music.run]: { file: file(music.run), bus: "music" },
};

/**
 * The sounds the app gives `SurvivorsCueTable`, by cue: which of its sounds each cue plays. A
 * weapon's `sound` in `weapons.json` plays in place of `shot`.
 */
export const byCue: CueSoundsOf<typeof SurvivorsCueTable> = {
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
