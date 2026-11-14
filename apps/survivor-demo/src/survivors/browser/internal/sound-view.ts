/**
 * Survivors' sound view: a view that plays a run's cues from the app's sounds.
 *
 * Each frame it compares the run's cue counters (`World.Cues`) with what it saw the frame before,
 * and plays one sound for each counter that rose, however far it rose: the audio system's voice
 * limits keep a jump from playing as a burst. A bolt plays its weapon's own shot sound where the
 * content names one. Every peer hears the whole fight, and a teammate's hurt and down are quieter.
 * The aura hum is read from the state: it loops while a playing hero has an aura and the run
 * steps, and stops while the run is frozen (paused, or waiting on an upgrade pick). It reads the
 * run and never changes it.
 *
 * Plain on purpose: a frame draws whole, sound included, before the browser shows it, so
 * `render` is a plain call; playing a sound is one too.
 */
import type { AudioSystem, CueSoundsOf } from "arcadekit/audio";
import type * as Game from "arcadekit/game/browser";

import * as World from "../../world";
import type { SurvivorsCueTable } from "../cue-table";

const firstHero = () => 0;

/** What the view saw of one run: the run, its counters last frame and each weapon's shot sound. */
interface Seen {
  readonly arena: World.Arena;
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

const see = (
  arena: World.Arena,
  sounds: CueSoundsOf<typeof SurvivorsCueTable>
): Seen => {
  const { cues } = arena;
  return {
    arena,
    shots: Float64Array.from(cues.shots),
    shotSounds: arena.content.weapons.map((def) => def.sound ?? sounds.shot),
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
const auraPlaying = (arena: World.Arena): boolean =>
  arena.status === "running" &&
  !World.isChoosing(arena) &&
  !arena.heroes.some((hero) => hero.paused) &&
  arena.heroes.some(
    (hero) =>
      hero.status === "playing" &&
      hero.weapons.some((slot) => slot.def.behavior.kind === "aura")
  );

/**
 * Makes a view that plays a run's cues through `audio`, with the app's `sounds`.
 *
 * The first frame of a run only takes its counts, so a view made mid-run plays nothing for what
 * came before; a new run, told apart by its state object, takes fresh counts, and so does the
 * same run after a frame with none. `localHero` gives the slot of this browser's hero, read on
 * every frame: its hurt and down play at full volume, and first, so a sound's minimum gap may
 * drop a teammate's that frame, never its own. It defaults to slot 0, `teammateVolume` to 0.45 and
 * `auraVolume` to 0.6. `dispose` stops the hum.
 */
export const make = (
  audio: AudioSystem.AudioSystem,
  sounds: CueSoundsOf<typeof SurvivorsCueTable>,
  options: {
    readonly localHero?: () => number;
    readonly teammateVolume?: number;
    readonly auraVolume?: number;
  } = {}
): Game.View<World.Arena> => {
  const localHero = options.localHero ?? firstHero;
  const teammateVolume = options.teammateVolume ?? 0.45;
  const auraVolume = options.auraVolume ?? 0.6;
  let seen: Seen | null = null;
  /** The run time last seen, and the render time it last changed: a run that stops stepping (a single-player pause) stops the hum. */
  let runTime = Number.NaN;
  let steppedAt = 0;

  /**
   * One sound per hero whose counter rose, the local hero's first and loudest: a teammate's
   * play that same frame may then be dropped by the sound's minimum gap, never the local one.
   */
  const playByHero = (
    counts: Uint32Array,
    saw: Float64Array,
    sound: string
  ) => {
    const local = localHero();
    if (counts[local] !== undefined && counts[local] > saw[local]!) {
      saw[local] = counts[local];
      audio.play(sound);
    }
    for (let slot = 0; slot < counts.length; slot += 1) {
      if (slot !== local && counts[slot]! > saw[slot]!) {
        saw[slot] = counts[slot]!;
        audio.play(sound, { volume: teammateVolume });
      }
    }
  };

  const playRises = (saw: Seen) => {
    const { cues } = saw.arena;
    for (let i = 0; i < cues.shots.length; i += 1) {
      if (cues.shots[i]! > saw.shots[i]!) {
        saw.shots[i] = cues.shots[i]!;
        audio.play(saw.shotSounds[i]!);
      }
    }
    if (cues.hits > saw.hits) {
      saw.hits = cues.hits;
      audio.play(sounds.hit);
    }
    if (cues.kills > saw.kills) {
      saw.kills = cues.kills;
      audio.play(sounds.kill);
    }
    if (cues.pickups > saw.pickups) {
      saw.pickups = cues.pickups;
      audio.play(sounds.pickup);
    }
    playByHero(cues.hurt, saw.hurt, sounds.hurt);
    playByHero(cues.downed, saw.downed, sounds.down);
    if (cues.levelUps > saw.levelUps) {
      saw.levelUps = cues.levelUps;
      audio.play(sounds.levelUp);
    }
    if (cues.won > saw.won) {
      saw.won = cues.won;
      audio.play(sounds.won);
    }
    if (cues.lost > saw.lost) {
      saw.lost = cues.lost;
      audio.play(sounds.lost);
    }
  };

  return {
    render: (arena, timeSeconds) => {
      if (arena === null) {
        seen = null;
        audio.setLoop(sounds.auraHum, 0);
        return;
      }
      if (seen?.arena === arena) {
        playRises(seen);
      } else {
        seen = see(arena, sounds);
        runTime = Number.NaN;
      }
      if (arena.time !== runTime) {
        runTime = arena.time;
        steppedAt = timeSeconds;
      }
      const stepping = timeSeconds - steppedAt < STALL_SECONDS;
      audio.setLoop(
        sounds.auraHum,
        stepping && auraPlaying(arena) ? auraVolume : 0
      );
    },
    dispose: () => {
      seen = null;
      audio.setLoop(sounds.auraHum, 0);
    },
  };
};
