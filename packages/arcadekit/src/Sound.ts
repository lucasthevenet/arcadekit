/**
 * Sound: a service that plays a named cue, driven by events.
 *
 *   // The simulation says what happened. It knows nothing of sound.
 *   const Collided = Event.define("physics/Collided", Schema.Struct({ speed: Schema.Finite }))
 *
 *   // What it sounds like: a system of the frame stage.
 *   const Cues = Sound.cues("game/Cues",
 *     Sound.on(Scored, "coin"),
 *     Sound.on(Collided, ({ speed }) => ({ cue: "thud", volume: Math.min(1, speed / 10) }))
 *   )
 *
 *   const Game = Plugin.make("Game", {
 *     plugins: [Sound.plugin],
 *     systems: [Physics, Cues],
 *   })
 *
 *   // Where it goes: in a page, the files of the cues.
 *   Browser.runMain(App.run({ plugins: [Game] }, { hz: 60 }), {
 *     sounds: { coin: "/coin.wav", thud: "/thud.wav" },
 *   })
 *
 * Music is not an event but a state of things: what should be heard for
 * as long as the game is as it is. A system of the frame stage says so
 * each frame, and the player starts, fades and stops what it takes:
 *
 *   const Score = Sound.music("game/Score", function*() {
 *     const level = yield* Level
 *     return level.value === "menu" ? "menu-theme" : { track: "forest-theme", volume: 0.6 }
 *   })
 *
 * A level's own sounds are assets of its bundle, `Browser.sound(url)` in a
 * page, loaded and let go with the rest of it:
 *
 *   const ForestCues = Sound.cues("forest/Cues", Forest, ({ creak, chirp }) => [
 *     Sound.on(Stepped, creak),
 *     Sound.on(Chirped, chirp),
 *   ])
 *
 * Sound follows real time, so it is no part of the simulation. A tick
 * emits events; a system of the frame stage, which hears every event
 * once however many ticks ran since the last frame, plays what they sound
 * like. The simulation never calls the player: in the tick, playing
 * throws. A replay and a server, which run no frame stage, play nothing,
 * and the game they run is the same game.
 */
import { Context, Effect, Layer } from "effect";

import * as Assets from "./Assets";
import type * as Event from "./Event";
import * as Plugin from "./Plugin";
import { World } from "./Services";
import type { Events } from "./Services";
import * as System from "./System";

// --- a sound that is not a name ------------------------------------------------------

/**
 * A sound that was loaded, as an output takes it: a level's, held by its
 * bundle. Wherever a cue's or a track's name goes, a clip goes too.
 *
 * It is made by whatever loads it for the output that will play it: in a
 * page, the asset `Browser.sound(url)`. `name` is what a log or a recorder
 * calls it, and `data` what the output plays, which only the output reads.
 */
export class Clip {
  constructor(
    readonly name: string,
    readonly data: unknown
  ) {}
}

/**
 * A clip of your own making: for an output of your own, or for a test,
 * which needs nothing to play.
 *
 *   const Forest = Assets.bundle("game/Forest", {
 *     chirp: Assets.make("/chirp.wav", () => Effect.succeed(Sound.clip("chirp"))),
 *   })
 */
export const clip = (name: string, data?: unknown): Clip =>
  new Clip(name, data);

/** What can be played: a sound of the output's own, by its name, or one that was loaded. */
export type Playable = string | Clip;

const nameOf = (sound: Playable): string =>
  typeof sound === "string" ? sound : sound.name;

// --- where sound goes ------------------------------------------------------------

export interface OutputShape {
  /**
   * Starts a cue now: at `volume`, where 1 is the cue as it was recorded,
   * and `rate` times its own speed, which is its pitch too.
   */
  readonly play: (cue: Playable, volume: number, rate: number) => void;
  /**
   * Says what a channel is to play from now on: `track` at `volume`,
   * reached over `fade` seconds from whatever it was playing, which fades
   * out as long. It plays over and over, or with `once` to its end and no
   * further. No track is silence. It is told only when one of these
   * changes.
   */
  readonly music: (
    channel: string,
    track: Playable | undefined,
    volume: number,
    fade: number,
    once?: boolean
  ) => void;
}

const silent: OutputShape = { play() {}, music() {} };

/**
 * Where sound goes. A `Context.Reference` whose default is nowhere, which
 * is what a server, a replay and most tests want. A page provides its
 * own: `Browser.layerSound(files)`, or the `sounds` of `Browser.runMain`.
 * A test provides one that notes what it was asked, `Sound.makeRecorder()`.
 */
export const Output: Context.Reference<OutputShape> =
  Context.Reference<OutputShape>("arcadekit/Sound.Output", {
    defaultValue: () => silent,
  });

/** Provides an output to the game: `Effect.provide(Sound.layer(output))`. */
export const layer = (output: OutputShape): Layer.Layer<never> =>
  Layer.succeed(Output, output) as Layer.Layer<never>;

/** A cue that was played, as a recorder notes it. */
export interface Played {
  /** The cue's name, or the name of the clip that was played. */
  readonly cue: string;
  readonly volume: number;
  readonly rate: number;
  /** The clip itself, when it was one. */
  readonly clip?: Clip;
}

/** What a channel was told to play, as a recorder notes it. */
export interface Scored {
  readonly channel: string;
  /** The track's name, or the name of the clip; `undefined` for silence. */
  readonly track: string | undefined;
  readonly volume: number;
  readonly fade: number;
  /** The clip itself, when it was one. */
  readonly clip?: Clip;
  /** There, and true, for a track that is to play once and end. */
  readonly once?: true;
}

export interface Recorder extends OutputShape {
  /** Every cue it was asked to play, oldest first. */
  readonly played: Played[];
  /** Everything a channel was told, oldest first. */
  readonly scored: Scored[];
  /** What each channel is playing now, by its name: no entry is silence. */
  readonly playing: Map<string, string>;
}

/**
 * An output that plays nothing and notes what it was asked to, for a test
 * or a tool:
 *
 *   const sound = Sound.makeRecorder()
 *   const app = yield* App.make({ plugins: [Game] }).pipe(
 *     Effect.provide(Sound.layer(sound))
 *   )
 *   app.tick(1 / 60)
 *   app.frame(0)
 *   sound.played   // [{ cue: "coin", volume: 1, rate: 1 }]
 */
export const makeRecorder = (): Recorder => {
  const played: Played[] = [];
  const scored: Scored[] = [];
  const playing = new Map<string, string>();
  return {
    played,
    scored,
    playing,
    play(cue, volume, rate) {
      played.push(
        typeof cue === "string"
          ? { cue, volume, rate }
          : { cue: cue.name, volume, rate, clip: cue }
      );
    },
    music(channel, track, volume, fade, once) {
      if (track === undefined) {
        playing.delete(channel);
        scored.push({ channel, track, volume, fade });
        return;
      }
      playing.set(channel, nameOf(track));
      scored.push({
        channel,
        track: nameOf(track),
        volume,
        fade,
        ...(typeof track === "string" ? {} : { clip: track }),
        ...(once === true ? { once } : {}),
      });
    },
  };
};

// --- the player ------------------------------------------------------------------

/** How a cue is played. */
export interface Options {
  /** How loud: 1, the cue as it was recorded, when left out. Not below 0. */
  readonly volume?: number;
  /** How fast, and so how high: 1, its own speed, when left out. */
  readonly rate?: number;
}

/** How a channel plays its track. */
export interface MusicOptions {
  /** How loud: 1, the track as it was recorded, when left out. Not below 0. */
  readonly volume?: number;
  /**
   * How many seconds a change takes: the new track or volume fades in,
   * and what was playing fades out as long. Half a second when left out;
   * 0 is at once.
   */
  readonly fade?: number;
  /**
   * Whether the track plays to its end and no further, where it would
   * play over and over: a fanfare. It is not started again while the
   * channel is told the same track; told another, or silence, and then
   * this one again, it plays again from its start.
   */
  readonly once?: boolean;
}

export interface PlayerShape {
  /** Whether sound goes anywhere. False on a server, in a replay, in most tests. */
  readonly audible: boolean;
  /**
   * Plays a cue, by its name or as a clip, now. For the stages between
   * ticks: in the tick it throws, since the simulation does not play.
   */
  readonly play: (cue: Playable, options?: Options) => void;
  /**
   * Says what a channel is to be playing, over and over or with `once` to
   * its end: a track, or `undefined` for silence. Said again with the
   * same track and volume it does nothing, so a system says it every
   * frame; said with another, the output fades from the one to the other. A channel is any name:
   * `Sound.music` uses its system's. Between ticks only, as `play`.
   */
  readonly music: (
    channel: string,
    track: Playable | undefined,
    options?: MusicOptions
  ) => void;
}

/**
 * An app's player of cues. `Sound.plugin` provides it and `Sound.cues`
 * works it. A system of the frame stage can play through it too, for a
 * sound that no event stands for: `(yield* Sound.Player).play("click")`.
 */
export class Player extends Context.Service<Player, PlayerShape>()(
  "arcadekit/Sound.Player"
) {}

const playerLayer = Layer.effect(
  Player,
  Effect.gen(function* () {
    const output = yield* Output;
    // Between ticks an app's world is frozen: that is how the stages that
    // may play are told from the tick.
    const world = yield* World;
    // What each channel was last told: the output hears of a change only.
    const channels = new Map<
      string,
      { track: Playable | undefined; volume: number; once: boolean }
    >();
    // An app that goes leaves nothing playing in an output that stays.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const [channel, told] of channels) {
          if (told.track !== undefined) {
            output.music(channel, undefined, 0, 0, false);
          }
        }
        channels.clear();
      })
    );
    return {
      audible: output !== silent,
      play(cue, options) {
        if (!world.frozen) {
          throw new Error(
            `The cue "${nameOf(cue)}" was played in the tick. Sound follows real time and is no part of the game: a replay and a server play nothing, and a tick must not depend on whether anything is heard. Emit an event for what happened, and play what it sounds like from a system of the frame stage, which Sound.cues makes.`
          );
        }
        output.play(cue, Math.max(0, options?.volume ?? 1), options?.rate ?? 1);
      },
      music(channel, track, options) {
        if (!world.frozen) {
          throw new Error(
            `The music of "${channel}" was set in the tick. Sound follows real time and is no part of the game: a replay and a server play nothing, and a tick must not depend on whether anything is heard. Say what should be playing from a system of the frame stage, which Sound.music makes, from the game as it is.`
          );
        }
        const volume =
          track === undefined ? 0 : Math.max(0, options?.volume ?? 1);
        const once = track !== undefined && options?.once === true;
        const told = channels.get(channel);
        if (told === undefined) {
          // A channel that was never told anything is silent already.
          if (track === undefined) {
            return;
          }
          channels.set(channel, { track, volume, once });
        } else if (
          told.track === track &&
          told.volume === volume &&
          told.once === once
        ) {
          return;
        } else {
          told.track = track;
          told.volume = volume;
          told.once = once;
        }
        output.music(
          channel,
          track,
          volume,
          Math.max(0, options?.fade ?? 0.5),
          once
        );
      },
    };
  })
);

/**
 * Gives an app a player of cues, which plays to the output the app was
 * given. A plugin whose systems are made with `Sound.cues` lists it in
 * `plugins`.
 */
export const plugin = Plugin.make("arcadekit/Sound", { layer: playerLayer });

// --- cues: from the game's events to what they sound like ---------------------------

/** A cue with how to play it. */
export interface Cue extends Options {
  readonly cue: Playable;
}

/**
 * What an event sounds like: a cue's name or a clip, either with how to
 * play it, or how to make one of those of the event, which may be nothing.
 */
export type CueOf<P> =
  | Playable
  | Cue
  | ((payload: P) => Playable | Cue | undefined);

/** One line of `Sound.cues`: when this event happens, play that cue. */
export interface Line {
  /** @internal */
  readonly event: Event.EventDef<any>;
  /** @internal */
  readonly pick: (payload: any) => Playable | Cue | undefined;
}

/**
 * Plays a cue each time an event happens.
 *
 *   Sound.on(Scored, "coin")
 *   Sound.on(Collided, ({ speed }) => ({ cue: "thud", volume: Math.min(1, speed / 10) }))
 *   Sound.on(Landed, ({ hard }) => (hard ? "crash" : undefined))
 *
 * The cue is a name or a clip, either with a volume and a rate, or a
 * function of the event's payload that gives one of those, or nothing.
 */
export const on = <P>(event: Event.EventDef<P>, cue: CueOf<P>): Line => ({
  event,
  pick: typeof cue === "function" ? cue : () => cue,
});

/** The assets of a bundle, whatever they are. */
// `any`: an asset is of whatever its `decode` makes.
type Entries = Readonly<Record<string, Assets.Asset<any>>>;

const isCue = (picked: Playable | Cue): picked is Cue =>
  typeof picked !== "string" && !(picked instanceof Clip);

/** Lines by the event they are of: what a system hears of an event it hears once, for all of them. */
type Heard = readonly (readonly [
  Event.EventDef<any>,
  readonly Line["pick"][],
])[];

const byEvent = (lines: readonly Line[]): Heard => {
  const found = new Map<Event.EventDef<any>, Line["pick"][]>();
  for (const line of lines) {
    const picks = found.get(line.event);
    if (picks === undefined) {
      found.set(line.event, [line.pick]);
    } else {
      picks.push(line.pick);
    }
  }
  return Array.from(found);
};

/**
 * Makes a system of the frame stage out of lines: each frame it plays what
 * the events since the last frame sound like.
 *
 *   const Cues = Sound.cues("game/Cues",
 *     Sound.on(Scored, "coin"),
 *     Sound.on(Collided, "thud")
 *   )
 *
 * - It hears every event once, whatever order the systems run in and
 *   however many ticks ran since the last frame, as any frame system
 *   does.
 * - A cue that several events of one frame ask for is played once, as
 *   the loudest of them asked: forty coins caught in one tick are one
 *   sound, not forty on top of each other.
 * - Cues are played in the order they were first asked for.
 * - Where sound goes nowhere it reads nothing and plays nothing.
 * - It needs `Sound.plugin`, and takes `System.runIf` like any system.
 *
 * A level's cues are sounds its bundle holds. Given the bundle, the lines
 * are made of what it holds, once each time it is loaded:
 *
 *   const ForestCues = Sound.cues("forest/Cues", Forest, ({ creak, chirp }) => [
 *     Sound.on(Stepped, creak),
 *     Sound.on(Chirped, ({ near }) => ({ cue: chirp, volume: near ? 1 : 0.3 })),
 *   ])
 *
 * - While the app does not hold the bundle loaded nothing is played, and
 *   what happened meanwhile is not played later.
 * - It needs `Assets.plugin` as well.
 */
export const cues: {
  <B extends Entries>(
    name: string,
    from: Assets.Bundle<B>,
    lines: (assets: Assets.Loaded<B>) => readonly Line[]
  ): System.System<never, Player | Events | Assets.Store>;
  (
    name: string,
    ...lines: readonly Line[]
  ): System.System<never, Player | Events>;
} = (
  name: string,
  ...rest: readonly unknown[]
  // `any`: the system of lines that are there asks for no store of assets,
  // which the two signatures above say and one body cannot.
): System.System<never, any> => {
  const from = rest[0] instanceof Assets.Bundle ? rest[0] : undefined;
  const fixed =
    from === undefined ? byEvent(rest as readonly Line[]) : undefined;
  const make = rest[1] as (assets: unknown) => readonly Line[];
  // The lines of a bundle, and the assets they were made of: per app, by
  // the app's player, since a system is made once and may be in several.
  const made = new WeakMap<
    PlayerShape,
    { readonly assets: unknown; readonly lines: Heard }
  >();
  return System.make(name, function* () {
    const player = yield* Player;
    if (!player.audible) {
      return;
    }
    let lines = fixed;
    if (from !== undefined) {
      const status = yield* from;
      if (status._tag !== "Ready") {
        // The lines hold the bundle's clips: let go, so that they can be.
        made.delete(player);
        return;
      }
      let now = made.get(player);
      if (now === undefined || now.assets !== status.assets) {
        now = { assets: status.assets, lines: byEvent(make(status.assets)) };
        made.set(player, now);
      }
      ({ lines } = now);
    }
    // Made only in a frame that has something to play.
    let asked: Map<Playable, { volume: number; rate: number }> | undefined;
    for (const [event, picks] of lines!) {
      // Read once: a system is handed an event once, however many of its
      // lines are of it.
      const heard = (yield* event).read();
      for (const pick of picks) {
        for (const payload of heard) {
          const picked = pick(payload);
          if (picked === undefined) {
            continue;
          }
          const cue = isCue(picked) ? picked.cue : picked;
          const volume = isCue(picked) ? (picked.volume ?? 1) : 1;
          const rate = isCue(picked) ? (picked.rate ?? 1) : 1;
          asked ??= new Map();
          const already = asked.get(cue);
          if (already === undefined) {
            asked.set(cue, { volume, rate });
          } else if (volume > already.volume) {
            already.volume = volume;
            already.rate = rate;
          }
        }
      }
    }
    if (asked !== undefined) {
      for (const [cue, how] of asked) {
        player.play(cue, how);
      }
    }
  }).pipe(System.inStage("frame"));
};

// --- music: what should be heard, for as long as the game is as it is ----------------

/** A track with how to play it. */
export interface Track extends MusicOptions {
  readonly track: Playable;
}

/** What a channel should be playing: a track, one with how to play it, or nothing. */
export type TrackOf = Playable | Track | undefined;

const isTrack = (picked: Playable | Track): picked is Track =>
  typeof picked !== "string" && !(picked instanceof Clip);

/**
 * Makes a system of the frame stage that keeps a channel playing what the
 * game, as it is, should sound like: each frame the body says which track,
 * and the track is started, faded to another, or stopped when what it
 * says changes.
 *
 *   const Score = Sound.music("game/Score", function*() {
 *     const level = yield* Level
 *     if ((yield* Paused).on) return { track: "theme", volume: 0.2 }
 *     return level.value === "menu" ? undefined : "theme"
 *   }, { fade: 1 })
 *
 * - A track plays over and over until the body says another, or nothing.
 *   It is a name the output knows, a clip, or either with a `volume` and
 *   a `fade` of its own.
 * - With `once: true` a track plays to its end and no further: a fanfare
 *   for as long as the game is won, `{ track: "fanfare", once: true }`. It
 *   is not started again while the body says the same, and it fades like
 *   any other when the body says something else before it has ended.
 * - It is worked out from the game and kept nowhere in it: a game that is
 *   loaded from a save, or an app that starts in the middle of a level,
 *   has its music from its first frame.
 * - The body reads what a system of the frame stage can: singletons,
 *   states, queries, events, assets. A level's own music is a clip of its
 *   bundle: `const forest = yield* Forest`, and `forest.assets.theme` once
 *   it is `Ready`.
 * - The system's name is its channel. Two systems are two channels, which
 *   play together: music, and the wind.
 * - `fade` is how many seconds a change takes, half a second when left
 *   out.
 * - Where sound goes nowhere the body is not run at all.
 * - It needs `Sound.plugin`. Under `System.runIf` its channel is silent
 *   while the condition does not hold, as if the body had said so: music
 *   that is for a level stops when the level is left. Run again, the body
 *   says what plays, from the start of the track.
 */
export const music = <Eff extends Effect.Effect<any, any, any>>(
  name: string,
  body: () => Generator<Eff, TrackOf, never>,
  options: { readonly fade?: number } = {}
): System.System<Effect.Error<Eff>, Effect.Services<Eff> | Player> => {
  const pick = Effect.gen(body) as Effect.Effect<
    TrackOf,
    Effect.Error<Eff>,
    Effect.Services<Eff>
  >;
  return System.make(name, function* () {
    const player = yield* Player;
    if (!player.audible) {
      return;
    }
    const picked = yield* pick;
    if (picked === undefined) {
      player.music(name, undefined, options);
    } else if (isTrack(picked)) {
      player.music(name, picked.track, {
        volume: picked.volume ?? 1,
        fade: picked.fade ?? options.fade ?? 0.5,
        once: picked.once === true,
      });
    } else {
      player.music(name, picked, options);
    }
  }).pipe(
    System.inStage("frame"),
    // Not run, it is not asked, and there is nothing it says should play.
    System.otherwise(
      Effect.map(Player, (player) => {
        player.music(name, undefined, options);
      })
    )
  ) as System.System<Effect.Error<Eff>, Effect.Services<Eff> | Player>;
};
