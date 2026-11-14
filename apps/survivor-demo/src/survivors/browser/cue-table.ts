/**
 * Survivors' cue table, declared: which of the app's sounds each of its cues plays.
 */
import { AudioSystem, CueTable } from "arcadekit/audio";

/**
 * Survivors' cues, `shot`, `hit`, `kill`, `pickup`, `hurt`, `down`, `levelUp`, `won`, `lost` and
 * `auraHum`, each played by one of the app's sounds. The genre ships no sound: the app owns the
 * files, and gives each cue one.
 *
 * **When to use**
 *
 * In an app, to give the genre its sounds: `SurvivorsCueTable.layer({ shot: "shot-arc", ... })`,
 * with an id from the app's sound list for each cue.
 *
 * **Details**
 *
 * The engine's sound view plays a cue's sound when its cue counter rises (`World.Cues`), once per
 * frame however far it rose. A bolt whose content names a `sound` plays that in place of `shot`.
 * `hurt` and `down` play quieter for a teammate's hero. `auraHum` loops while a playing hero has
 * an aura and the run steps. The layer refuses a cue left out and a sound for no cue.
 *
 * **Example** (An app's sounds)
 *
 * ```ts
 * import { SurvivorsCueTable } from "../survivors/browser/index";
 * import type { CueSoundsOf } from "arcadekit/audio";
 *
 * const sounds: CueSoundsOf<typeof SurvivorsCueTable> = {
 *   shot: "shot-arc",
 *   hit: "hit",
 *   kill: "kill",
 *   pickup: "pickup",
 *   hurt: "hurt",
 *   down: "down",
 *   levelUp: "level-up",
 *   won: "won",
 *   lost: "lost",
 *   auraHum: "aura-hum",
 * };
 * Object.keys(SurvivorsCueTable.cues).length; // => 10
 * sounds.auraHum; // => "aura-hum"
 * ```
 *
 * @category declarations
 */
export class SurvivorsCueTable extends CueTable("SurvivorsCueTable", {
  cues: {
    /** A bolt weapon's shot, when its content names no `sound` of its own. */
    shot: AudioSystem.SoundId,
    /** A bolt hitting an enemy. */
    hit: AudioSystem.SoundId,
    kill: AudioSystem.SoundId,
    /** A hero picking up a gem. */
    pickup: AudioSystem.SoundId,
    /** A hero taking contact damage. */
    hurt: AudioSystem.SoundId,
    /** A hero going down. */
    down: AudioSystem.SoundId,
    /** The team gaining a level. */
    levelUp: AudioSystem.SoundId,
    won: AudioSystem.SoundId,
    lost: AudioSystem.SoundId,
    /** Loops while a playing hero has an aura weapon. */
    auraHum: AudioSystem.SoundId,
  },
}) {}
