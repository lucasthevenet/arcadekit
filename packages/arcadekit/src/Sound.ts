/**
 * Sound plays cues in response to events, and keeps music playing to match
 * the game's state.
 *
 *   // The simulation reports what happened. It knows nothing about sound.
 *   const Collided = Event.define("physics/Collided", Schema.Struct({ speed: Schema.Finite }))
 *
 *   // The sounds, by name: a cue that isn't in the sheet doesn't compile.
 *   const Sfx = Sound.sheet("game/Sfx", { coin: "/coin.wav", thud: "/thud.wav" })
 *
 *   // What it sounds like: a frame-stage system.
 *   const Cues = Sound.cues("game/Cues",
 *     Sound.on(Scored, Sfx.coin),
 *     Sound.on(Collided, ({ speed }) => ({ cue: Sfx.thud, volume: Math.min(1, speed / 10) }))
 *   )
 *
 *   const Game = Plugin.make("game/Game", {
 *     plugins: [Sound.plugin],
 *     systems: [Physics, Cues],
 *   })
 *
 *   // Where it plays: in a page, which fetches the sheet's files.
 *   Browser.runMain(Driver.run(App.define({ plugins: [Game] }), { hz: 60 }), {
 *     sounds: [Sfx],
 *   })
 *
 * Music isn't an event. It is what should be heard for as long as the game
 * stays as it is. A frame-stage system returns it each frame, and the player
 * starts, fades and stops tracks to match:
 *
 *   const Score = Sound.music("game/Score", function*() {
 *     const level = yield* State.Reader(Level)
 *     return level.value === "menu" ? Tracks.menu : { track: Tracks.forest, volume: 0.6 }
 *   })
 *
 * Every sound plays on a bus, `Sound.EffectsBus` for a cue and
 * `Sound.MusicBus` for a track unless it names another, and a frame-stage
 * system sets a bus's volume while the game runs, as a settings menu does:
 *
 *   (yield* Sound.Player).volume(Sound.MusicBus, 0.5)
 *
 * A level's own sounds are assets of its bundle, made with `Audio.sound(url)`
 * in a page. They load and are released with the rest of the bundle:
 *
 *   const ForestCues = Sound.cues("forest/Cues", Forest, ({ creak, chirp }) => [
 *     Sound.on(Stepped, creak),
 *     Sound.on(Chirped, chirp),
 *   ])
 *
 * Sound follows real time, so it isn't part of the simulation. A tick emits
 * events, and a frame-stage system plays what they sound like. It reads every
 * event once, however many ticks ran since the last frame. A system of the
 * tick or the input stage, and an action handler, cannot require
 * `Sound.Player`, so the simulation never plays sound. A replay and a server
 * run no frame stage. They play nothing, and the game they run is the same.
 */
import { Context, Effect, Layer } from "effect";
import type { Scope } from "effect";

import * as Assets from "./Assets.ts";
import * as Event from "./Event.ts";
import { Entry } from "./internal/sheet.ts";
import { make as makeSystem } from "./internal/system.ts";
import * as Plugin from "./Plugin.ts";
import type { Events } from "./Services.ts";
import * as System from "./System.ts";

// --- what is played --------------------------------------------------------------------

/**
 * A sound that can be played: a sound of a cue sheet, a level's sound held by
 * its bundle, or a stream. Every cue and every track is a clip.
 *
 * **Details**
 *
 * Whatever makes a clip makes it for the output that will play it: a sheet
 * names a file that a page fetches, and the `Audio.sound(url)` asset is
 * decoded for a page. `name` is what a log or a recorder calls it. `data` is
 * what the output plays, and only the output reads it.
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
 * Makes a clip by hand, for an output of your own or for a test, where nothing
 * needs to play.
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
 * What can be played: a clip, of a sheet, of a bundle, or made by hand.
 *
 * @category Models
 */
export type Playable = Clip;

/**
 * A cue sheet: a game's sounds for its whole lifetime, each a clip under its
 * name, made by `Sound.sheet`.
 *
 * @category Models
 */
export type Sheet<K extends string = string> = { readonly [P in K]: Clip };

/**
 * Makes a cue sheet: a clip for each sound a game plays by name, from the URL
 * of its file, or from a clip such as `Audio.stream(url)`. A cue or a track
 * names a sound as a property of the sheet, so a name that isn't in it doesn't
 * compile, and a page given the sheet fetches its files.
 *
 *   const Sfx = Sound.sheet("game/Sfx", { coin: "/coin.wav", thud: "/thud.wav" })
 *
 *   Sound.on(Scored, Sfx.coin)
 *   Sound.on(Scored, Sfx.coni)                  // doesn't compile
 *   Browser.runMain(game, { sounds: [Sfx] })
 *
 * **When to use**
 *
 * Use for the sounds a game has from start to end: its cues, its menu's
 * music. A level's own sounds, loaded and released with it, are assets of its
 * bundle, made with `Audio.sound(url)`.
 *
 * **Details**
 *
 * - Each clip's name is its key, as a recorder records it: `Sfx.coin` plays
 *   as `"coin"`.
 * - A page plays a sheet's files once it is given the sheet, in the `sounds`
 *   of `Browser.runMain` or `Audio.layerSound`, which fetches them when its
 *   audio starts. A recorder records them whatever it was given.
 *
 * **Gotchas**
 *
 * - A sound of a sheet that the page wasn't given plays nothing, and is
 *   logged once through Effect's logger with the sheet's name.
 *
 * @category Constructors
 */
export const sheet = <const F extends Readonly<Record<string, string | Clip>>>(
  name: string,
  files: F
): Sheet<Extract<keyof F, string>> =>
  Object.fromEntries(
    Object.entries(files).map(([key, file]) => [
      key,
      new Clip(
        key,
        typeof file === "string"
          ? new Entry(name, file, undefined)
          : new Entry(name, undefined, file.data)
      ),
    ])
  ) as Sheet<Extract<keyof F, string>>;

const nameOf = (sound: Playable): string => sound.name;

/** A clip of a sheet, which a recorder records by its name alone, as a named sound. */
const isNamed = (sound: Playable): boolean => sound.data instanceof Entry;

// --- where sound goes ------------------------------------------------------------

/**
 * An opened output that plays sound, such as a page's Web Audio or a test's
 * recorder. `Sound.Player` tells it what to play once a frame's systems have
 * run.
 *
 * @category Models
 */
export interface Speaker {
  /**
   * Starts a cue now, at `volume`, where 1 is the cue as recorded, and at
   * `rate` times its normal speed, which also sets its pitch. The player
   * gives both, as `Sound.Player`'s `play` takes them by name.
   */
  readonly play: (
    cue: Playable,
    options: { readonly volume: number; readonly rate: number }
  ) => void;
  /**
   * Sets what a channel plays from now on: `track` at `volume`, faded in over
   * `fade` seconds while what the channel was playing fades out over the same
   * time. The track loops, or with `once` plays to its end and stops. No track
   * means silence. The player calls it only when one of these changes, with
   * each option given.
   */
  readonly music: (
    channel: string,
    track: Playable | undefined,
    options: {
      readonly volume: number;
      readonly fade: number;
      readonly once: boolean;
    }
  ) => void;
}

/**
 * The shape of `Sound.Output`. An output says how to open a speaker, and opens
 * nothing until `open` runs.
 *
 * @category Services
 */
export interface OutputShape {
  /**
   * Opens a speaker in the current scope, and lets go of it when that scope
   * closes.
   */
  readonly open: Effect.Effect<Speaker, never, Scope.Scope>;
}

const silent: Speaker = { play() {}, music() {} };

const nowhere: OutputShape = { open: Effect.succeed(silent) };

/**
 * Where an app's sound goes. Nothing has to provide it. By default sound goes
 * nowhere, as a server, a replay and most tests need.
 *
 * **Details**
 *
 * A page provides its own output with `Audio.layerSound(files)`, or with the
 * `sounds` option of `Browser.runMain`. A test provides a speaker that records
 * what it was asked, `Sound.layer(Sound.makeRecorder())`.
 *
 * An output opens nothing itself. `Sound.plugin` runs `open` in the app's own
 * scope, and lets go of the speaker when the app is closed. Wherever the
 * layer is provided, the app is heard for as long as it is open.
 *
 * @category Services
 */
export const Output: Context.Reference<OutputShape> =
  Context.Reference<OutputShape>("arcadekit/Sound.Output", {
    defaultValue: () => nowhere,
  });

/**
 * Opens `Sound.Output` in the current scope, and returns its speaker. The
 * speaker is let go when that scope closes. `Sound.plugin` opens the output
 * in the app's own scope instead.
 *
 * **When to use**
 *
 * Use when a program plays to the speaker itself, outside an app.
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
  /** The clip's name: a sheet's key, such as `"coin"`, or a loaded clip's. */
  readonly cue: string;
  /** The volume it was played at, its bus's volume included. */
  readonly volume: number;
  readonly rate: number;
  /** The clip itself, for one that is no sheet's, such as a bundle's. */
  readonly clip?: Clip;
}

/**
 * What a channel was told to play, as a recorder records it.
 *
 * @category Testing
 */
export interface Told {
  readonly channel: string;
  /** The clip's name, such as a sheet's key, or `undefined` for silence. */
  readonly track: string | undefined;
  /** The volume it plays at, its bus's volume included. */
  readonly volume: number;
  readonly fade: number;
  /** The clip itself, for one that is no sheet's, such as a bundle's. */
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
  readonly scored: Told[];
  /** What each channel plays now, by channel name. A channel with no entry is silent. */
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
 *   yield* app.tick(1 / 60)
 *   yield* app.frame()
 *   sound.played   // [{ cue: "coin", volume: 1, rate: 1 }], for Sfx.coin
 *
 * @category Testing
 */
export const makeRecorder = (): Recorder => {
  const played: Played[] = [];
  const scored: Told[] = [];
  const playing = new Map<string, string>();
  return {
    played,
    scored,
    playing,
    play(cue, { rate, volume }) {
      played.push(
        isNamed(cue)
          ? { cue: cue.name, volume, rate }
          : { cue: cue.name, volume, rate, clip: cue }
      );
    },
    music(channel, track, { fade, once, volume }) {
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
        ...(isNamed(track) ? {} : { clip: track }),
        ...(once === true ? { once } : {}),
      });
    },
  };
};

// --- the player ------------------------------------------------------------------

/** The channel of a `Sound.music` system that names none. */
const MUSIC = "music";

/**
 * A group of sounds whose volume is set together, such as the music or the
 * effects of a settings menu. A bus is a value, declared once, so a bus that
 * was never declared doesn't compile.
 *
 *   player.volume(Sound.MusicBus, 0.5)
 *   player.volume(Sound.MusicBuss, 0.5)          // doesn't compile
 *
 * @category Models
 */
export class Bus {
  constructor(
    /** What an error calls it. */
    readonly name: string
  ) {}
}

/**
 * Declares a bus of a game's own, beside `Sound.MusicBus` and
 * `Sound.EffectsBus`, for sounds whose volume a menu sets apart, such as a
 * UI's clicks.
 *
 *   const UiBus = Sound.bus("ui")
 *   Sound.on(Clicked, { cue: Sfx.click, bus: UiBus })
 *   player.volume(UiBus, 0.5)
 *
 * **Gotchas**
 *
 * - Each call is a bus of its own: declare one once, at module level, and
 *   use that value everywhere, as a sheet's sounds are used.
 *
 * @category Constructors
 */
export const bus = (name: string): Bus => new Bus(name);

/**
 * The bus a track plays on unless it names another.
 *
 * @category Constants
 */
export const MusicBus: Bus = new Bus("music");

/**
 * The bus a cue plays on unless it names another.
 *
 * @category Constants
 */
export const EffectsBus: Bus = new Bus("effects");

/**
 * Options for playing a cue.
 *
 * @category Options
 */
export interface PlayOptions {
  /** The volume, where 1 is the cue as recorded. Defaults to 1. A negative volume plays as 0. */
  readonly volume?: number;
  /** The playback speed, and therefore pitch, where 1 is normal speed. Defaults to 1. */
  readonly rate?: number;
  /** The bus it plays on, whose volume scales its own. Defaults to `Sound.EffectsBus`. */
  readonly bus?: Bus;
}

/**
 * Options for how a channel plays its track.
 *
 * @category Options
 */
export interface MusicOptions {
  /** The volume, where 1 is the track as recorded. Defaults to 1. A negative volume plays as 0. */
  readonly volume?: number;
  /**
   * How many seconds a change takes. The new track or volume fades in while
   * what was playing fades out over the same time. Defaults to half a second,
   * and 0 changes at once.
   */
  readonly fade?: number;
  /**
   * Whether the track plays to its end and stops instead of looping, as a
   * fanfare does. It isn't restarted while the channel keeps being given the
   * same track. Given another track or silence, and then this one again, it
   * plays again from the start.
   */
  readonly once?: boolean;
  /** The bus it plays on, whose volume scales its own. Defaults to `Sound.MusicBus`. */
  readonly bus?: Bus;
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
   * Plays a cue, by name or as a clip, once every system of the frame has run.
   * A cue requested several times in one frame, by any system, plays once, at
   * the loudest requested volume. Cues play in the order they were first
   * requested.
   */
  readonly play: (cue: Playable, options?: PlayOptions) => void;
  /**
   * Sets what a channel should play: a track, which loops or with `once` plays
   * to its end, or `undefined` for silence. Setting the same track and volume
   * again does nothing, so a system can set it every frame. Setting another
   * fades from one to the other.
   *
   * Everything a frame's systems set for one channel resolves to one request,
   * which the output receives once they have all run. A track wins over
   * silence, whichever was set first, so among the systems that share a
   * channel, the one with something to play is heard. Two different tracks set
   * for one channel in one frame, or one track at two volumes, throws, since a
   * channel plays one track at a time.
   *
   * A channel can have any name. `Sound.music` uses `"music"` unless given
   * another.
   */
  readonly music: (
    channel: string,
    track: Playable | undefined,
    options?: MusicOptions
  ) => void;
  /**
   * Sets a bus's volume, which scales the volume of everything that plays on
   * it: 1 plays it as asked, 0.5 at half, and 0 silences it. Every bus is at 1
   * until it is set. Cues play on `Sound.EffectsBus` and tracks on
   * `Sound.MusicBus` unless they name another, declared with `Sound.bus`.
   *
   *   const Volumes = System.frame("game/Volumes", function*() {
   *     const settings = yield* Setting.get(Settings)
   *     const player = yield* Sound.Player
   *     player.volume(Sound.MusicBus, settings.music)
   *     player.volume(Sound.EffectsBus, settings.effects ? 1 : 0)
   *   })
   *
   * The volume holds from the end of the frame, for the cues of that frame
   * and every later one, until it is set again, so a system can set it every
   * frame. A track that plays on a bus whose volume changes is made louder or
   * softer at once, and keeps playing. It throws for a volume below 0 or that
   * is not a number.
   */
  readonly volume: (bus: Bus, volume: number) => void;
}

/**
 * An app's sound player, which `Sound.plugin` provides. `Sound.cues` and
 * `Sound.music` play through it.
 *
 * **When to use**
 *
 * Use in a frame-stage system to play a sound that no event stands for:
 *
 *   (yield* Sound.Player).play(Sfx.click, { volume: 0.5 })
 *
 * **Gotchas**
 *
 * - Only a frame-stage system can require it. A system of the tick or the
 *   input stage, and an action handler, don't compile with it.
 *
 * @category Services
 */
export class Player extends Context.Service<Player, PlayerShape>()(
  "arcadekit/Sound.Player"
) {}

/**
 * What `Sound.plugin`'s player does around a frame, by the player: forget what
 * the last frame asked for, which a failed frame never played, and play what
 * was asked for since the frame began.
 */
const frames = new WeakMap<
  PlayerShape,
  { readonly begin: () => void; readonly flush: () => void }
>();

const playerLayer = Layer.effect(
  Player,
  Effect.gen(function* () {
    const speaker = yield* open;
    // Each bus's volume, 1 until a system sets it.
    const buses = new Map<Bus, number>();
    const busVolume = (bus: Bus): number => buses.get(bus) ?? 1;
    // What each channel was last told: the speaker hears of a change only.
    // And what this frame's systems have said of it so far, if any has:
    // kept in the same record, so that a frame makes none.
    const channels = new Map<
      string,
      {
        track: Playable | undefined;
        /** The volume asked for, and the bus's volume times it, as the speaker was told. */
        base: number;
        volume: number;
        once: boolean;
        bus: Bus;
        said: boolean;
        next: Playable | undefined;
        nextVolume: number;
        nextOnce: boolean;
        nextFade: number;
        nextBus: Bus;
      }
    >();
    const describe = (
      track: Playable,
      volume: number,
      once: boolean,
      bus: Bus
    ) =>
      `"${nameOf(track)}"${volume === 1 ? "" : ` at ${volume}`}${once ? ", once" : ""}${bus === MusicBus ? "" : ` on the bus "${bus.name}"`}`;
    // An app that goes leaves nothing playing in a speaker that stays.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const [channel, told] of channels) {
          if (told.track !== undefined) {
            speaker.music(channel, undefined, {
              volume: 0,
              fade: 0,
              once: false,
            });
          }
        }
        channels.clear();
        asked.clear();
      })
    );
    // What a frame's systems have asked to hear, by the cue: one sound for
    // each, however many asked and whichever system they were.
    const asked = new Map<
      Playable,
      { volume: number; rate: number; bus: Bus }
    >();
    const player: PlayerShape = {
      audible: speaker !== silent,
      play(cue, options) {
        const volume = Math.max(0, options?.volume ?? 1);
        const already = asked.get(cue);
        if (already === undefined) {
          asked.set(cue, {
            volume,
            rate: options?.rate ?? 1,
            bus: options?.bus ?? EffectsBus,
          });
        } else if (volume > already.volume) {
          already.volume = volume;
          already.rate = options?.rate ?? 1;
          already.bus = options?.bus ?? EffectsBus;
        }
      },
      music(channel, track, options) {
        const volume =
          track === undefined ? 0 : Math.max(0, options?.volume ?? 1);
        const once = track !== undefined && options?.once === true;
        const fade = Math.max(0, options?.fade ?? 0.5);
        const bus = options?.bus ?? MusicBus;
        const told = channels.get(channel);
        if (told === undefined) {
          // A channel that was never told anything is silent already.
          if (track !== undefined) {
            channels.set(channel, {
              track: undefined,
              base: 0,
              volume: 0,
              once: false,
              bus,
              said: true,
              next: track,
              nextVolume: volume,
              nextOnce: once,
              nextFade: fade,
              nextBus: bus,
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
          told.nextBus = bus;
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
          told.nextBus = bus;
          return;
        }
        if (
          told.next !== track ||
          told.nextVolume !== volume ||
          told.nextOnce !== once ||
          told.nextBus !== bus
        ) {
          throw new Error(
            `The channel "${channel}" was told to play two things in one frame: ${describe(told.next, told.nextVolume, told.nextOnce, told.nextBus)} and ${describe(track, volume, once, bus)}. A channel plays one track at a time. The systems made with Sound.music share the channel "${MUSIC}" unless they name another: they are one score, of which one says what plays. For two that play together, music and the wind, give one a channel of its own: Sound.music(name, body, { channel: "wind" }).`
          );
        }
      },
      volume(bus, volume) {
        if (!(volume >= 0 && Number.isFinite(volume))) {
          throw new Error(
            `The bus "${bus.name}" was given the volume ${volume}. A bus's volume is a number from 0, silent, up, where 1 plays what is on it as it asks.`
          );
        }
        buses.set(bus, volume);
      },
    };
    frames.set(player, {
      begin() {
        for (const told of channels.values()) {
          told.said = false;
        }
        asked.clear();
      },
      flush() {
        for (const [channel, told] of channels) {
          // Not said this frame, a channel keeps what it plays, at its bus's
          // volume of now.
          const track = told.said ? told.next : told.track;
          if (track === undefined && told.track === undefined) {
            continue;
          }
          const base = told.said ? told.nextVolume : told.base;
          const once = told.said ? told.nextOnce : told.once;
          const bus = told.said ? told.nextBus : told.bus;
          const volume = base * busVolume(bus);
          if (
            told.track === track &&
            told.volume === volume &&
            told.once === once
          ) {
            told.base = base;
            told.bus = bus;
            continue;
          }
          // Only its bus's volume changed: at once, as a menu's slider moves.
          const fade =
            told.track === track && told.base === base && told.once === once
              ? 0
              : told.nextFade;
          told.track = track;
          told.base = base;
          told.volume = volume;
          told.once = once;
          told.bus = bus;
          speaker.music(channel, track, { volume, fade, once });
        }
        for (const [cue, how] of asked) {
          speaker.play(cue, {
            volume: how.volume * busVolume(how.bus),
            rate: how.rate,
          });
        }
      },
    });
    return player;
  })
);

/** Forgets what the last frame asked to hear, before any system asks. */
const Begin = System.frame("arcadekit/Sound.Begin", function* () {
  frames.get(yield* Player)?.begin();
}).pipe(System.inStage("preFrame"));

/** Plays what the frame's systems asked to hear, once they have all run. */
const Flush = System.frame("arcadekit/Sound.Flush", function* () {
  frames.get(yield* Player)?.flush();
}).pipe(System.inStage("postFrame"));

/**
 * Plays what the frame's systems request. A game with cues or music lists it
 * among its plugins.
 *
 * **Details**
 *
 * It provides `Sound.Player`. It also adds a system in `"postFrame"`, the stage
 * after the frame's own, that passes the frame's requests to the speaker once
 * all the frame's systems have run, and one in `"preFrame"` that starts each
 * frame with nothing requested: what a failed frame requested is never played,
 * and holds nothing against the next. It opens `Sound.Output` when the app is
 * made, wherever the output was provided. When the app is closed, every
 * playing channel is silenced at once, and the plugin lets go of the speaker.
 *
 * @category Plugins
 */
export const plugin = Plugin.make("arcadekit/Sound", {
  layer: playerLayer,
  systems: [Begin, Flush],
});

// --- cues: from the game's events to what they sound like ---------------------------

/**
 * A cue, with how to play it.
 *
 * @category Models
 */
export interface Cue extends PlayOptions {
  readonly cue: Playable;
}

/**
 * What an event sounds like: a cue's name or a clip, optionally with playback
 * options, or a function of the event's payload that returns one of those, or
 * nothing.
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
export interface Binding {
  /** The event it plays a cue for. */
  readonly event: Event.Event<unknown>;
  /** What it plays for an event's payload, or nothing. */
  readonly pick: (payload: never) => Playable | Cue | undefined;
}

/**
 * Makes an entry of `Sound.cues` that plays a cue each time an event happens.
 *
 *   Sound.on(Scored, Sfx.coin)
 *   Sound.on(Collided, ({ speed }) => ({ cue: Sfx.thud, volume: Math.min(1, speed / 10) }))
 *   Sound.on(Landed, ({ hard }) => (hard ? Sfx.crash : undefined))
 *   Sound.on(Clicked, { cue: Sfx.click, bus: UiBus })
 *
 * The cue is a clip, such as a sound of a sheet, optionally with a volume, a
 * rate and a bus, or a function of the event's payload that returns one of
 * those, or nothing. Several entries can share an event, and each receives
 * it.
 *
 * @category Constructors
 */
export const on = <P>(event: Event.Event<P>, cue: CueOf<P>): Binding => ({
  event,
  pick: typeof cue === "function" ? cue : () => cue,
});

/** The assets of a bundle, whatever their types. */
// `any`: an asset is of whatever its `decode` makes.
type Entries = Readonly<Record<string, Assets.Asset<unknown>>>;

const isCue = (picked: Playable | Cue): picked is Cue =>
  !(picked instanceof Clip);

/** Entries grouped by event, so a system reads each event once for all of them. */
type Heard = readonly (readonly [
  Event.Event<unknown>,
  readonly Binding["pick"][],
])[];

const byEvent = (lines: readonly Binding[]): Heard => {
  const found = new Map<Event.Event<unknown>, Binding["pick"][]>();
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
 * Makes a frame-stage system from entries. Each frame, it plays what the events
 * since the last frame sound like.
 *
 *   const Cues = Sound.cues("game/Cues",
 *     Sound.on(Scored, Sfx.coin),
 *     Sound.on(Collided, Sfx.thud)
 *   )
 *
 * **Details**
 *
 * - Like any frame system, it reads every event once, whatever order the
 *   systems run in and however many ticks ran since the last frame.
 * - A cue that several events in one frame request plays once, at the loudest
 *   requested volume. Forty coins caught in one tick make one sound, not forty.
 *   Two systems that play the same cue in one frame also make one sound.
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
  lines: (assets: Assets.Loaded<B>) => readonly Binding[]
): System.System<never, Player | Events | Assets.Store>;
export function cues(
  name: string,
  ...lines: readonly Binding[]
): System.System<never, Player | Events>;
// One body for both: the system of lines that are there asks for no store of
// assets, which the second signature says.
export function cues(
  name: string,
  ...rest: readonly unknown[]
): System.System<never, Player | Events | Assets.Store> {
  const from = rest[0] instanceof Assets.Bundle ? rest[0] : undefined;
  const fixed =
    from === undefined ? byEvent(rest as readonly Binding[]) : undefined;
  const make = rest[1] as (assets: unknown) => readonly Binding[];
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
      const status = yield* Assets.Status(from);
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
      const heard = (yield* Event.Reader(event)).read();
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
  !(picked instanceof Clip);

/**
 * Makes a frame-stage system that keeps a channel playing the music that
 * matches the game's state. Each frame the body returns a track or nothing, and
 * the player starts, cross-fades or stops tracks when the result changes.
 *
 *   const Score = Sound.music("game/Score", function*() {
 *     const level = yield* State.Reader(Level)
 *     if ((yield* Singleton.Read(Paused)).on) return { track: Tracks.theme, volume: 0.2 }
 *     return level.value === "menu" ? undefined : Tracks.theme
 *   }, { fade: 1 })
 *
 * **Details**
 *
 * - A track loops until the body returns another, or nothing. It is a clip,
 *   such as a sound of a sheet, or one with its own `volume` and `fade`.
 * - With `once: true`, a track plays to its end and stops, such as a fanfare
 *   for as long as the game is won: `{ track: Tracks.fanfare, once: true }`. It
 *   isn't restarted while the body keeps returning it. When the body returns
 *   something else before it ends, it fades like any other track.
 * - Music is computed from the game and stored nowhere in it. A game loaded
 *   from a save, or an app that starts in the middle of a level, has its music
 *   from the first frame.
 * - The body can read whatever a frame-stage system can: singletons, states,
 *   queries, events and assets. A level's own music is a clip from its bundle,
 *   such as `forest.assets.theme` once `yield* Assets.Status(Forest)` is `Ready`.
 * - Music systems share one score, on the `"music"` channel. Between a menu's
 *   system and a level's, the one with something to play is heard, and a track
 *   both play continues without a break from one to the other.
 * - Music that plays alongside the score uses a `channel` of its own, with any
 *   name, such as `Sound.music("game/Wind", body, { channel: "wind" })`.
 *   Channels play at the same time.
 * - `fade` is how many seconds a change takes. Defaults to half a second.
 * - Its tracks play on `Sound.MusicBus`, or on the `bus` it names, whose
 *   volume `Sound.Player`'s `volume` sets.
 * - When sound goes nowhere, the body doesn't run at all.
 * - It requires `Sound.plugin`.
 * - Under `System.runIf`, while the condition doesn't hold, the system requests
 *   silence as if the body had returned nothing. A level's music therefore
 *   fades out when the player leaves the level, unless another system on its
 *   channel plays. When the system runs again, the body's track plays from its
 *   start.
 *
 * **Gotchas**
 *
 * - Two systems that return different tracks for one channel in one frame, or
 *   one track at two volumes, fail the frame at the second. The error names the
 *   channel and both tracks.
 *
 * @category Systems
 */
export function music<Eff extends Effect.Effect<unknown, unknown, unknown>>(
  name: string,
  body: System.FrameBody<Eff, TrackOf>,
  options?: {
    readonly fade?: number;
    readonly channel?: string;
    readonly bus?: Bus;
  }
): System.System<System.GenError<Eff>, System.GenServices<Eff> | Player>;
export function music<Eff extends Effect.Effect<unknown, unknown, unknown>>(
  name: string,
  body: () => Generator<Eff, TrackOf, never>,
  options: {
    readonly fade?: number;
    readonly channel?: string;
    readonly bus?: Bus;
  } = {}
): System.System<System.GenError<Eff>, System.GenServices<Eff> | Player> {
  const pick = Effect.gen(body);
  const channel = options.channel ?? MUSIC;
  return makeSystem(name, "frame", function* () {
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
        bus: picked.bus ?? options.bus ?? MusicBus,
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
