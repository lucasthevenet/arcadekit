/**
 * Sound plays named cues in response to events, and keeps music playing to
 * match the game's state.
 *
 *   // The simulation reports what happened. It knows nothing about sound.
 *   const Collided = Event.define("physics/Collided", Schema.Struct({ speed: Schema.Finite }))
 *
 *   // What it sounds like: a frame-stage system.
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
 *   // Where it plays: in a page, with the cues' files.
 *   Browser.runMain(Driver.run(App.make(App.define({ plugins: [Game] })), { hz: 60 }), {
 *     sounds: { coin: "/coin.wav", thud: "/thud.wav" },
 *   })
 *
 * Music isn't an event but a state: what should be heard for as long as the
 * game stays as it is. A frame-stage system declares it each frame, and the
 * player starts, fades and stops tracks as needed:
 *
 *   const Score = Sound.music("game/Score", function*() {
 *     const level = yield* Level
 *     return level.value === "menu" ? "menu-theme" : { track: "forest-theme", volume: 0.6 }
 *   })
 *
 * A level's own sounds are assets in its bundle, `Browser.sound(url)` in a
 * page, loaded and released with the rest of it:
 *
 *   const ForestCues = Sound.cues("forest/Cues", Forest, ({ creak, chirp }) => [
 *     Sound.on(Stepped, creak),
 *     Sound.on(Chirped, chirp),
 *   ])
 *
 * Sound follows real time, so it isn't part of the simulation. A tick emits
 * events; a frame-stage system, which reads every event once however many ticks
 * ran since the last frame, plays what they sound like. The simulation never
 * calls the player: playing during the tick throws. A replay and a server,
 * which run no frame stage, play nothing, and the game they run is the same.
 */
import { Context, Effect, Layer } from "effect";
import type { Scope } from "effect";

import * as Assets from "./Assets";
import type * as Event from "./Event";
import * as Plugin from "./Plugin";
import type { Events } from "./Services";
import * as System from "./System";

// --- a sound that is not a name ------------------------------------------------------

/**
 * A loaded sound, as an output accepts it: for example, a level's sound held by
 * its bundle. A clip works anywhere a cue's or a track's name does.
 *
 * Whatever loads it creates it for the output that will play it: in a page, the
 * `Browser.sound(url)` asset. `name` is what a log or a recorder calls it, and
 * `data` is what the output plays, which only the output reads.
 *
 * @category Models
 */
export class Clip {
  constructor(
    readonly name: string,
    readonly data: unknown
  ) {}
}

/**
 * Makes a clip by hand, for your own output, or for a test, where nothing needs
 * to play.
 *
 *   const Forest = Assets.bundle("game/Forest", {
 *     chirp: Assets.make("/chirp.wav", () => Effect.succeed(Sound.clip("chirp"))),
 *   })
 *
 * @category Constructors
 */
export const clip = (name: string, data?: unknown): Clip =>
  new Clip(name, data);

/**
 * What can be played: one of the output's own sounds, by name, or a loaded
 * clip.
 *
 * @category Models
 */
export type Playable = string | Clip;

const nameOf = (sound: Playable): string =>
  typeof sound === "string" ? sound : sound.name;

// --- where sound goes ------------------------------------------------------------

/**
 * What plays sound, opened: a page's Web Audio, or a recorder in a test. The
 * player tells it what to play once a frame has run.
 *
 * @category Models
 */
export interface Speaker {
  /**
   * Starts a cue now, at `volume`, where 1 is the cue as recorded, and at
   * `rate` times its normal speed, which also sets its pitch.
   */
  readonly play: (cue: Playable, volume: number, rate: number) => void;
  /**
   * Sets what a channel plays from now on: `track` at `volume`, faded in over
   * `fade` seconds from whatever it was playing, which fades out over the same
   * time. It loops, or with `once` plays to its end and stops. No track means
   * silence. It is only called when one of these changes.
   */
  readonly music: (
    channel: string,
    track: Playable | undefined,
    volume: number,
    fade: number,
    once?: boolean
  ) => void;
}

/**
 * Where sound goes: how to open a speaker, and not a speaker.
 *
 * @category Services
 */
export interface Output {
  /**
   * Opens a speaker in the current scope, and lets go of it when that scope
   * closes.
   */
  readonly open: Effect.Effect<Speaker, never, Scope.Scope>;
}

const silent: Speaker = { play() {}, music() {} };

const nowhere: Output = { open: Effect.succeed(silent) };

/**
 * Where an app's sound goes. A `Context.Reference` whose default is nowhere,
 * which suits a server, a replay and most tests. A page provides its own:
 * `Browser.layerSound(files)`, or the `sounds` option of `Browser.runMain`. A
 * test provides a speaker that records what it was asked,
 * `Sound.layer(Sound.makeRecorder())`.
 *
 * It opens nothing itself. `Sound.plugin` runs `open` in the scope the app is
 * made in, and lets go when that scope closes, so whatever the layer is
 * provided to, the app is heard for as long as the program that made it.
 *
 * @category Services
 */
export const Output: Context.Reference<Output> = Context.Reference<Output>(
  "arcadekit/Sound.Output",
  { defaultValue: () => nowhere }
);

/**
 * Opens the output in the current scope, as `Sound.plugin` does: for a program
 * that plays to it itself.
 *
 * @category Running
 */
export const open: Effect.Effect<Speaker, never, Scope.Scope> = Effect.flatMap(
  Output,
  (output) => output.open
);

/**
 * Returns a layer that provides a speaker made by hand, open already, such as
 * `Sound.makeRecorder()`.
 *
 *   App.make(game).pipe(Effect.provide(Sound.layer(sound)))
 *
 * @category Layers
 */
export const layer = (speaker: Speaker): Layer.Layer<never> =>
  Layer.succeed(Output, { open: Effect.succeed(speaker) });

/**
 * A played cue, as a recorder records it.
 *
 * @category Testing
 */
export interface Played {
  /** The cue's name, or the name of the clip that was played. */
  readonly cue: string;
  readonly volume: number;
  readonly rate: number;
  /** The clip itself, if it was one. */
  readonly clip?: Clip;
}

/**
 * What a channel was told to play, as a recorder records it.
 *
 * @category Testing
 */
export interface Scored {
  readonly channel: string;
  /** The track's name, or the clip's name; `undefined` for silence. */
  readonly track: string | undefined;
  readonly volume: number;
  readonly fade: number;
  /** The clip itself, if it was one. */
  readonly clip?: Clip;
  /** Present and true for a track that plays once and ends. */
  readonly once?: true;
}

/**
 * A speaker that records what it is told and plays nothing, from
 * `Sound.makeRecorder()`.
 *
 * @category Testing
 */
export interface Recorder extends Speaker {
  /** Every cue it was asked to play, oldest first. */
  readonly played: Played[];
  /** Everything a channel was told, oldest first. */
  readonly scored: Scored[];
  /** What each channel is currently playing, by channel name: a missing entry means silence. */
  readonly playing: Map<string, string>;
}

/**
 * Makes a speaker that plays nothing and records what it was asked, for a test
 * or a tool:
 *
 *   const sound = Sound.makeRecorder()
 *   const app = yield* App.make(App.define({ plugins: [Game] })).pipe(
 *     Effect.provide(Sound.layer(sound))
 *   )
 *   app.tick(1 / 60)
 *   app.frame(0)
 *   sound.played   // [{ cue: "coin", volume: 1, rate: 1 }]
 *
 * @category Testing
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

/** The channel of a `Sound.music` system that names none. */
const MUSIC = "music";

/**
 * Options for playing a cue.
 *
 * @category Options
 */
export interface Options {
  /** The volume, where 1 is the cue as recorded. Defaults to 1. Can't be negative. */
  readonly volume?: number;
  /** The playback speed, and therefore pitch, where 1 is normal speed. Defaults to 1. */
  readonly rate?: number;
}

/**
 * Options for how a channel plays its track.
 *
 * @category Options
 */
export interface MusicOptions {
  /** The volume, where 1 is the track as recorded. Defaults to 1. Can't be negative. */
  readonly volume?: number;
  /**
   * How many seconds a change takes: the new track or volume fades in, and what
   * was playing fades out over the same time. Defaults to half a second; 0 is
   * immediate.
   */
  readonly fade?: number;
  /**
   * Whether the track plays to its end and stops, instead of looping: a
   * fanfare, for example. It isn't restarted while the channel keeps being
   * given the same track; given another track, or silence, and then this one
   * again, it plays again from the start.
   */
  readonly once?: boolean;
}

/**
 * The player, as a frame-stage system gets it from `yield* Sound.Player`.
 *
 * @category Services
 */
export interface PlayerShape {
  /** Whether sound goes anywhere. False on a server, in a replay, and in most tests. */
  readonly audible: boolean;
  /**
   * Plays a cue, by name or as a clip, in the frame it is requested: the cues a
   * frame's systems request play once they have all run. A cue requested
   * several times in one frame, by any of them, plays once, at the loudest
   * requested volume; cues play in the order they were first requested. For the
   * stages between ticks: requested in the input stage, it plays with the
   * following frame; during the tick it throws, since the simulation doesn't
   * play sound.
   */
  readonly play: (cue: Playable, options?: Options) => void;
  /**
   * Plays what was asked for since this was last called.
   * @internal
   */
  readonly _flush: () => void;
  /**
   * Sets what a channel should be playing, looping or with `once` to its end: a
   * track, or `undefined` for silence. Setting the same track and volume again
   * does nothing, so a system can set it every frame; setting another fades
   * from one to the other.
   *
   * Everything a frame's systems set for one channel resolves to one request,
   * which the output receives once they have all run. A track wins over
   * silence, whichever was set first: among the systems that share a channel,
   * the one with something to play is heard. Two different tracks set for one
   * channel in one frame, or one track at two volumes, is a bug and throws: a
   * channel plays one thing at a time.
   *
   * A channel can have any name: `Sound.music` uses `"music"` unless given
   * another. Like `play`, it is only for the stages between ticks.
   */
  readonly music: (
    channel: string,
    track: Playable | undefined,
    options?: MusicOptions
  ) => void;
}

/**
 * An app's cue player. `Sound.plugin` provides it and `Sound.cues` drives it. A
 * frame-stage system can play through it too, for a sound no event represents:
 * `(yield* Sound.Player).play("click")`.
 *
 * @category Services
 */
export class Player extends Context.Service<Player, PlayerShape>()(
  "arcadekit/Sound.Player"
) {}

const playerLayer = Layer.effect(
  Player,
  Effect.gen(function* () {
    const speaker = yield* open;
    // What each channel was last told: the speaker hears of a change only.
    // And what this frame's systems have said of it so far, if any has:
    // kept in the same record, so that a frame makes none.
    const channels = new Map<
      string,
      {
        track: Playable | undefined;
        volume: number;
        once: boolean;
        said: boolean;
        next: Playable | undefined;
        nextVolume: number;
        nextOnce: boolean;
        nextFade: number;
      }
    >();
    const describe = (track: Playable, volume: number, once: boolean) =>
      `"${nameOf(track)}"${volume === 1 ? "" : ` at ${volume}`}${once ? ", once" : ""}`;
    // An app that goes leaves nothing playing in a speaker that stays.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const [channel, told] of channels) {
          if (told.track !== undefined) {
            speaker.music(channel, undefined, 0, 0, false);
          }
        }
        channels.clear();
        asked.clear();
      })
    );
    // What a frame's systems have asked to hear, by the cue: one sound for
    // each, however many asked and whichever system they were.
    const asked = new Map<Playable, { volume: number; rate: number }>();
    return {
      audible: speaker !== silent,
      play(cue, options) {
        const volume = Math.max(0, options?.volume ?? 1);
        const already = asked.get(cue);
        if (already === undefined) {
          asked.set(cue, { volume, rate: options?.rate ?? 1 });
        } else if (volume > already.volume) {
          already.volume = volume;
          already.rate = options?.rate ?? 1;
        }
      },
      _flush() {
        for (const [channel, told] of channels) {
          if (!told.said) {
            continue;
          }
          told.said = false;
          const { next, nextOnce, nextVolume } = told;
          if (
            told.track === next &&
            told.volume === nextVolume &&
            told.once === nextOnce
          ) {
            continue;
          }
          told.track = next;
          told.volume = nextVolume;
          told.once = nextOnce;
          speaker.music(channel, next, nextVolume, told.nextFade, nextOnce);
        }
        if (asked.size === 0) {
          return;
        }
        for (const [cue, how] of asked) {
          speaker.play(cue, how.volume, how.rate);
        }
        asked.clear();
      },
      music(channel, track, options) {
        const volume =
          track === undefined ? 0 : Math.max(0, options?.volume ?? 1);
        const once = track !== undefined && options?.once === true;
        const fade = Math.max(0, options?.fade ?? 0.5);
        const told = channels.get(channel);
        if (told === undefined) {
          // A channel that was never told anything is silent already.
          if (track !== undefined) {
            channels.set(channel, {
              track: undefined,
              volume: 0,
              once: false,
              said: true,
              next: track,
              nextVolume: volume,
              nextOnce: once,
              nextFade: fade,
            });
          }
          return;
        }
        if (!told.said) {
          told.said = true;
          told.next = track;
          told.nextVolume = volume;
          told.nextOnce = once;
          told.nextFade = fade;
          return;
        }
        // Said already this frame. Silence gives way to a track, whichever
        // came first; the same thing said twice is said once.
        if (track === undefined) {
          return;
        }
        if (told.next === undefined) {
          told.next = track;
          told.nextVolume = volume;
          told.nextOnce = once;
          told.nextFade = fade;
          return;
        }
        if (
          told.next !== track ||
          told.nextVolume !== volume ||
          told.nextOnce !== once
        ) {
          // The frame ends here, and what it said with it.
          told.said = false;
          throw new Error(
            `The channel "${channel}" was told to play two things in one frame: ${describe(told.next, told.nextVolume, told.nextOnce)} and ${describe(track, volume, once)}. A channel plays one track at a time. The systems made with Sound.music share the channel "${MUSIC}" unless they name another: they are one score, of which one says what plays. For two that play together, music and the wind, give one a channel of its own: Sound.music(name, body, { channel: "wind" }).`
          );
        }
      },
    };
  })
);

/** Plays what the frame's systems asked to hear, once they have all run. */
const Flush = System.frame("arcadekit/Sound.Flush", function* () {
  (yield* Player)._flush();
}).pipe(System.inStage("postFrame"));

/**
 * Plays what the frame's systems request. A game with cues or music lists it
 * among its plugins.
 *
 * It provides `Sound.Player`, and a system in the stage after a frame's own,
 * `"postFrame"`, that passes the frame's requests to the speaker once all its
 * systems have run. It opens `Sound.Output` in the scope the app is made in,
 * wherever the output was provided. When that scope closes, every playing
 * channel is silenced at once, and the speaker is let go.
 *
 * @category Plugins
 */
export const plugin = Plugin.make("arcadekit/Sound", {
  layer: playerLayer,
  systems: [Flush],
});

// --- cues: from the game's events to what they sound like ---------------------------

/**
 * A cue, with how to play it.
 *
 * @category Models
 */
export interface Cue extends Options {
  readonly cue: Playable;
}

/**
 * What an event sounds like: a cue's name or a clip, optionally with playback
 * options, or a function of the event that returns one of those, or nothing.
 *
 * @category Type-level
 */
export type CueOf<P> =
  | Playable
  | Cue
  | ((payload: P) => Playable | Cue | undefined);

/**
 * One entry of `Sound.cues`: when this event happens, play that cue.
 *
 * @category Models
 */
export interface Line {
  /** @internal */
  readonly event: Event.EventDef<unknown>;
  /** @internal */
  readonly pick: (payload: never) => Playable | Cue | undefined;
}

/**
 * Plays a cue each time an event happens.
 *
 *   Sound.on(Scored, "coin")
 *   Sound.on(Collided, ({ speed }) => ({ cue: "thud", volume: Math.min(1, speed / 10) }))
 *   Sound.on(Landed, ({ hard }) => (hard ? "crash" : undefined))
 *
 * The cue is a name or a clip, optionally with a volume and a rate, or a
 * function of the event's payload that returns one of those, or nothing.
 * Several entries can share an event, and each receives it.
 *
 * @category Constructors
 */
export const on = <P>(event: Event.EventDef<P>, cue: CueOf<P>): Line => ({
  event,
  pick: typeof cue === "function" ? cue : () => cue,
});

/** The assets of a bundle, whatever their types. */
// `any`: an asset is of whatever its `decode` makes.
type Entries = Readonly<Record<string, Assets.Asset<unknown>>>;

const isCue = (picked: Playable | Cue): picked is Cue =>
  typeof picked !== "string" && !(picked instanceof Clip);

/** Entries grouped by event, so a system reads each event once for all of them. */
type Heard = readonly (readonly [
  Event.EventDef<unknown>,
  readonly Line["pick"][],
])[];

const byEvent = (lines: readonly Line[]): Heard => {
  const found = new Map<Event.EventDef<unknown>, Line["pick"][]>();
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
 * Makes a frame-stage system from entries: each frame, it plays what the events
 * since the last frame sound like.
 *
 *   const Cues = Sound.cues("game/Cues",
 *     Sound.on(Scored, "coin"),
 *     Sound.on(Collided, "thud")
 *   )
 *
 * - Like any frame system, it reads every event once, whatever order the
 *   systems run in and however many ticks ran since the last frame.
 * - A cue that several events in one frame request plays once, at the loudest
 *   requested volume: forty coins caught in one tick make one sound, not forty
 *   layered. This holds across systems too: two systems that play the same cue
 *   in one frame produce one sound.
 * - Cues play in the order they were first requested.
 * - When sound goes nowhere, it reads nothing and plays nothing.
 * - It requires `Sound.plugin`, and accepts `System.runIf` like any system.
 *
 * A level's cues are sounds in its bundle. Given the bundle, the entries are
 * built from what it holds, once each time it loads:
 *
 *   const ForestCues = Sound.cues("forest/Cues", Forest, ({ creak, chirp }) => [
 *     Sound.on(Stepped, creak),
 *     Sound.on(Chirped, ({ near }) => ({ cue: chirp, volume: near ? 1 : 0.3 })),
 *   ])
 *
 * - While the app doesn't have the bundle loaded, nothing plays, and events
 *   from that time aren't played later.
 * - It also requires `Assets.plugin`.
 *
 * @category Systems
 */
export function cues<B extends Entries>(
  name: string,
  from: Assets.Bundle<B>,
  lines: (assets: Assets.Loaded<B>) => readonly Line[]
): System.System<never, Player | Events | Assets.Store>;
export function cues(
  name: string,
  ...lines: readonly Line[]
): System.System<never, Player | Events>;
// One body for both: the system of lines that are there asks for no store of
// assets, which the second signature says.
export function cues(
  name: string,
  ...rest: readonly unknown[]
): System.System<never, Player | Events | Assets.Store> {
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
  return System.frame(name, function* () {
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
    for (const [event, picks] of lines!) {
      // Read once: a system is handed an event once, however many of its
      // lines are of it.
      const heard = (yield* event).read();
      for (const pick of picks) {
        for (const payload of heard) {
          // Of the line's event, which is the one it was read from.
          const picked = pick(payload as never);
          if (picked === undefined) {
            continue;
          }
          // The player makes one sound of all that ask for the same cue.
          if (isCue(picked)) {
            player.play(picked.cue, picked);
          } else {
            player.play(picked);
          }
        }
      }
    }
  });
}

// --- music: what should be heard, for as long as the game is as it is ----------------

/**
 * A track, with how to play it.
 *
 * @category Models
 */
export interface Track extends MusicOptions {
  readonly track: Playable;
}

/**
 * What a channel should be playing: a track, a track with playback options, or
 * nothing.
 *
 * @category Type-level
 */
export type TrackOf = Playable | Track | undefined;

const isTrack = (picked: Playable | Track): picked is Track =>
  typeof picked !== "string" && !(picked instanceof Clip);

/**
 * Makes a frame-stage system that keeps a channel playing the music that
 * matches the game's state: each frame the body returns a track, and the track
 * is started, cross-faded or stopped when the result changes.
 *
 *   const Score = Sound.music("game/Score", function*() {
 *     const level = yield* Level
 *     if ((yield* Paused).on) return { track: "theme", volume: 0.2 }
 *     return level.value === "menu" ? undefined : "theme"
 *   }, { fade: 1 })
 *
 * - A track loops until the body returns another, or nothing. It is a name the
 *   output knows, a clip, or either with its own `volume` and `fade`.
 * - With `once: true`, a track plays to its end and stops: a fanfare for as
 *   long as the game is won, `{ track: "fanfare", once: true }`. It isn't
 *   restarted while the body keeps returning it, and fades like any other track
 *   when the body returns something else before it ends.
 * - It is derived from the game and stored nowhere in it: a game loaded from a
 *   save, or an app that starts in the middle of a level, has its music from
 *   the first frame.
 * - The body can read whatever a frame-stage system can: singletons, states,
 *   queries, events and assets. A level's own music is a clip from its bundle:
 *   `const forest = yield* Forest`, then `forest.assets.theme` once it is
 *   `Ready`.
 * - All such systems share one score, on the `"music"` channel: between a
 *   menu's and a level's, the one with something to play is heard, and a track
 *   both play continues seamlessly from one to the other. Two that return
 *   different tracks in one frame, or one track at two volumes, is a bug: the
 *   frame fails at the second, with an error naming the channel and both
 *   tracks.
 * - Music that plays alongside the score uses its own `channel`, with any name:
 *   `Sound.music("game/Wind", body, { channel: "wind" })`. Channels play
 *   simultaneously.
 * - `fade` is how many seconds a change takes. Defaults to half a second.
 * - When sound goes nowhere, the body doesn't run at all.
 * - It requires `Sound.plugin`. Under `System.runIf`, while the condition
 *   doesn't hold, it requests silence as if the body had returned nothing: a
 *   level's music stops, with its fade, when the player leaves the level,
 *   unless another system on its channel plays. When the system runs again, the
 *   body's track plays from its start.
 *
 * @category Systems
 */
export function music<Eff extends Effect.Effect<unknown, unknown, unknown>>(
  name: string,
  body: System.FrameBody<Eff, TrackOf>,
  options?: { readonly fade?: number; readonly channel?: string }
): System.System<System.GenError<Eff>, System.GenServices<Eff> | Player>;
export function music<Eff extends Effect.Effect<unknown, unknown, unknown>>(
  name: string,
  body: () => Generator<Eff, TrackOf, never>,
  options: { readonly fade?: number; readonly channel?: string } = {}
): System.System<System.GenError<Eff>, System.GenServices<Eff> | Player> {
  const pick = Effect.gen(body);
  const channel = options.channel ?? MUSIC;
  return System.raw(name, "frame", function* () {
    const player = yield* Player;
    if (!player.audible) {
      return;
    }
    const picked = yield* pick;
    if (picked === undefined) {
      player.music(channel, undefined, options);
    } else if (isTrack(picked)) {
      player.music(channel, picked.track, {
        volume: picked.volume ?? 1,
        fade: picked.fade ?? options.fade ?? 0.5,
        once: picked.once === true,
      });
    } else {
      player.music(channel, picked, options);
    }
  }).pipe(
    // Not run, it is not asked, and there is nothing it says should play.
    System.otherwise(
      Effect.map(Player, (player) => {
        player.music(channel, undefined, options);
      })
    )
  );
}
