import type { AudioSystem } from "arcadekit/audio";
import type * as Game from "arcadekit/game/browser";

import { isChoosing } from "../world";
import type { World } from "../world";

/**
 * The app's table of cue to sound: an id from the app's sound list for each of survivors'
 * cue counters (ADR-0014). The genre ships no sounds.
 */
export interface SurvivorsSounds {
  /** A bolt weapon's shot, when its content names no `sound` of its own. */
  readonly shot: string;
  /** A bolt hitting an enemy. */
  readonly hit: string;
  readonly kill: string;
  /** A hero picking up a gem. */
  readonly pickup: string;
  /** A hero taking contact damage. */
  readonly hurt: string;
  /** A hero going down. */
  readonly down: string;
  /** The team gaining a level. */
  readonly levelUp: string;
  readonly won: string;
  readonly lost: string;
  /** Loops while a playing hero has an aura weapon. */
  readonly auraHum: string;
}

const firstHero = () => 0;

interface SurvivorsSoundViewOptions {
  readonly audio: AudioSystem;
  readonly sounds: SurvivorsSounds;
  /**
   * The slot of this browser's hero: its hurt and down sounds play at full volume. Read on
   * every render. Defaults to slot 0.
   */
  readonly localHero?: () => number;
  /** The volume of a teammate's hurt and down sounds. Defaults to 0.45. */
  readonly teammateVolume?: number;
  /** The aura hum's volume. Defaults to 0.6. */
  readonly auraVolume?: number;
}

/** What the view saw of one run: the run, its counters last frame and each weapon's shot sound. */
interface Seen {
  readonly world: World;
  readonly shots: Float64Array;
  readonly shotSounds: readonly string[];
  readonly hurt: Float64Array;
  readonly downed: Float64Array;
  hits: number;
  kills: number;
  pickups: number;
  levelUps: number;
  won: number;
  lost: number;
}

const seeWorld = (world: World, sounds: SurvivorsSounds): Seen => {
  const { cues } = world;
  return {
    world,
    shots: Float64Array.from(cues.shots),
    shotSounds: world.content.weapons.map((def) => def.sound ?? sounds.shot),
    hurt: Float64Array.from(cues.hurt),
    downed: Float64Array.from(cues.downed),
    hits: cues.hits,
    kills: cues.kills,
    pickups: cues.pickups,
    levelUps: cues.levelUps,
    won: cues.won,
    lost: cues.lost,
  };
};

/**
 * How long the run may go without stepping before the hum stops: long enough to ride over
 * frames drawn between two steps, short enough that a pause silences it at once.
 */
const STALL_SECONDS = 0.25;

/**
 * Whether a playing hero carries an aura weapon while the run is on and not frozen: no upgrade
 * offer open and no player holding it paused.
 */
const auraPlaying = (world: World): boolean =>
  world.status === "running" &&
  !isChoosing(world) &&
  !world.heroes.some((hero) => hero.paused) &&
  world.heroes.some(
    (hero) =>
      hero.status === "playing" &&
      hero.weapons.some((slot) => slot.def.behavior.kind === "aura")
  );

/**
 * Plays a survivors run's sounds (ADR-0014). Each frame it compares `world.cues` with what it
 * saw last frame and plays one sound for each counter that rose, however far it rose: the audio
 * system's voice limits keep a jump from playing as a burst. The first frame of a run only
 * takes note of the counters. The aura hum is read from the state, and stops while the run is
 * frozen (paused, or waiting on an upgrade pick). Reads the run; never changes
 * it. Every peer hears the whole fight; a teammate's hurt and down are quieter.
 */
export class SurvivorsSoundView implements Game.View<World> {
  private readonly audio: AudioSystem;
  private readonly sounds: SurvivorsSounds;
  private readonly localHero: () => number;
  private readonly teammateVolume: number;
  private readonly auraVolume: number;
  private seen: Seen | null = null;
  /** The run time last seen, and the render time it last changed: a run that stops stepping (a single-player pause) stops the hum. */
  private runTime = Number.NaN;
  private steppedAt = 0;

  constructor(options: SurvivorsSoundViewOptions) {
    this.audio = options.audio;
    this.sounds = options.sounds;
    this.localHero = options.localHero ?? firstHero;
    this.teammateVolume = options.teammateVolume ?? 0.45;
    this.auraVolume = options.auraVolume ?? 0.6;
  }

  render(world: World | null, timeSeconds = 0): void {
    if (world === null) {
      this.seen = null;
      this.audio.setLoop(this.sounds.auraHum, 0);
      return;
    }
    if (this.seen?.world === world) {
      this.playRises(this.seen);
    } else {
      this.seen = seeWorld(world, this.sounds);
      this.runTime = Number.NaN;
    }
    if (world.time !== this.runTime) {
      this.runTime = world.time;
      this.steppedAt = timeSeconds;
    }
    const stepping = timeSeconds - this.steppedAt < STALL_SECONDS;
    this.audio.setLoop(
      this.sounds.auraHum,
      stepping && auraPlaying(world) ? this.auraVolume : 0
    );
  }

  dispose(): void {
    this.seen = null;
    this.audio.setLoop(this.sounds.auraHum, 0);
  }

  private playRises(seen: Seen) {
    const { audio, sounds } = this;
    const { cues } = seen.world;
    for (let i = 0; i < cues.shots.length; i += 1) {
      if (cues.shots[i]! > seen.shots[i]!) {
        seen.shots[i] = cues.shots[i]!;
        audio.play(seen.shotSounds[i]!);
      }
    }
    if (cues.hits > seen.hits) {
      seen.hits = cues.hits;
      audio.play(sounds.hit);
    }
    if (cues.kills > seen.kills) {
      seen.kills = cues.kills;
      audio.play(sounds.kill);
    }
    if (cues.pickups > seen.pickups) {
      seen.pickups = cues.pickups;
      audio.play(sounds.pickup);
    }
    this.playByHero(cues.hurt, seen.hurt, sounds.hurt);
    this.playByHero(cues.downed, seen.downed, sounds.down);
    if (cues.levelUps > seen.levelUps) {
      seen.levelUps = cues.levelUps;
      audio.play(sounds.levelUp);
    }
    if (cues.won > seen.won) {
      seen.won = cues.won;
      audio.play(sounds.won);
    }
    if (cues.lost > seen.lost) {
      seen.lost = cues.lost;
      audio.play(sounds.lost);
    }
  }

  /**
   * One sound per hero whose counter rose, the local hero's first and loudest: a teammate's
   * play that same frame may then be dropped by the sound's minimum gap, never the local one.
   */
  private playByHero(counts: Uint32Array, seen: Float64Array, sound: string) {
    const local = this.localHero();
    if (counts[local] !== undefined && counts[local] > seen[local]!) {
      seen[local] = counts[local];
      this.audio.play(sound);
    }
    for (let slot = 0; slot < counts.length; slot += 1) {
      if (slot !== local && counts[slot]! > seen[slot]!) {
        seen[slot] = counts[slot]!;
        this.audio.play(sound, { volume: this.teammateVolume });
      }
    }
  }
}
