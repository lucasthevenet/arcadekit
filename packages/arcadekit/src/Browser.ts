/**
 * Everything that only a page can use: its display, its input devices, its
 * images and sound, and the way a program starts in it. `arcadekit/Browser`
 * is the only entry point that imports a browser package, so a server, a
 * replay or a test of the game imports `arcadekit` alone.
 *
 *   import { App, Driver } from "arcadekit"
 *   import * as Browser from "arcadekit/Browser"
 *
 *   Browser.runMain(Driver.run(App.define({ plugins: [Game] }), { hz: 60 }), {
 *     target: canvas,
 *     preventDefault: ["Space", "ArrowUp", "ArrowDown"],
 *   })
 *
 * `Browser.runMain` runs the game with the platform's `runMain`, and provides
 * the page's display and devices to the whole program. The frame loop
 * follows `requestAnimationFrame`, and the input stage reads the keyboard,
 * the pointer and gamepads. When the page closes, the game is interrupted and
 * everything it holds is released.
 */
import * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";
import { Effect } from "effect";
import type { Layer, Runtime } from "effect";

import type * as Assets from "./Assets";
import * as audio from "./browser/internal/audio";
import * as media from "./browser/internal/media";
import * as page from "./browser/internal/page";
import type * as Driver from "./Driver";
import type * as Sound from "./Sound";

/**
 * A page's display, on which a frame is due once per repaint, with
 * `requestAnimationFrame`, and the game is hidden while the document is. It
 * holds no state.
 *
 * @category Services
 */
export const display: Driver.DisplayShape = page.display;

/**
 * The parts of a gamepad that are read. The browser's `Gamepad` satisfies it.
 *
 * @category Models
 */
export interface GamepadLike {
  readonly index: number;
  readonly connected: boolean;
  readonly buttons: ArrayLike<{ readonly pressed: boolean }>;
  readonly axes: ArrayLike<number>;
}

/**
 * The parts of an element the pointer is measured against.
 *
 * @category Models
 */
export interface PointerTarget extends EventTarget {
  readonly getBoundingClientRect?: () => {
    readonly left: number;
    readonly top: number;
  };
}

/**
 * Options for how `Browser.runMain` and `Browser.layer` connect a game to the
 * page: the pointer's target, gamepads, and sound.
 *
 * @category Options
 */
export interface Options {
  /**
   * The element the pointer is pressed on and measured from. `PointerX` and
   * `PointerY` are CSS pixels from its top-left corner. Defaults to the
   * window.
   */
  readonly target?: PointerTarget;
  /**
   * The codes of the keys whose default action in the page is prevented, such
   * as the arrows and the space bar, which scroll it.
   */
  readonly preventDefault?: readonly string[];
  /**
   * How far from center a gamepad axis must move to register. Anything
   * closer reads as 0. Defaults to 0.1. Values are rounded to two decimals,
   * so a stick held still doesn't report a change every frame.
   */
  readonly deadzone?: number;
  /** Where key presses and pointer movement are listened for. Defaults to the window. */
  readonly window?: EventTarget;
  /** The gamepads, read once per sample. Defaults to `navigator.getGamepads`. */
  readonly gamepads?: () => ArrayLike<GamepadLike | null>;
  /**
   * The page's sounds for its whole lifetime, by the name a cue or a track is
   * played with, as `Browser.layerSound` takes them. Each is the URL of a
   * file, which is fetched and decoded, or a clip, such as
   * `Browser.stream(url)` for a long piece of music. When omitted, the page
   * still plays the sounds in a level's bundle, made with `Browser.sound`.
   * `false` means no sound at all. No audio context is created, and the game
   * is told that nothing is heard.
   */
  readonly sounds?: Readonly<Record<string, string | Sound.Clip>> | false;
  /** The master volume. Defaults to 1, the volume the game requests. */
  readonly volume?: number;
  /** Creates the page's audio context. Defaults to `new AudioContext()`. */
  readonly audio?: () => AudioLike;
  /**
   * Decodes a sound from a file's bytes. Defaults to `decodeAudioData` on a
   * silent context, which needs no user gesture.
   */
  readonly decode?: (data: ArrayBuffer) => Promise<unknown>;
  /**
   * Creates the player for a streamed track from its URL. Defaults to an
   * `<audio>` element.
   */
  readonly media?: (url: string) => MediaLike;
}

/**
 * Returns a layer that provides a page's display and input devices to a whole
 * program.
 *
 * **Details**
 *
 * - The frame loop follows `requestAnimationFrame`, and pauses while the
 *   document is hidden.
 * - A key's code is its `KeyboardEvent.code`. A held key counts as pressed
 *   once, and every key and pointer button is released when the page loses
 *   focus.
 * - The pointer is a mouse, a pen or a finger. `PointerX` and `PointerY` are
 *   CSS pixels from the top-left of `target`. Presses are detected on `target`,
 *   and moves and releases anywhere on the page.
 * - Mouse buttons held together are tracked individually, even though the page
 *   reports every press but the first, and every release but the last, as
 *   moves.
 * - Gamepads are read when the input stage samples the devices, once before
 *   each tick. Unplugging one releases all its inputs.
 * - An asset's path is read against the document's base, its `<base href>`,
 *   as `fetch` reads it, unless a loader of the game's own, such as
 *   `Assets.layerMemory`, is provided around this layer.
 * - Each app listens to the devices for itself, from when `App.make` makes
 *   the app until the app is closed, wherever the layer is provided. Reading
 *   the devices after the app is closed throws, with an error that says so.
 * - Unless `sounds` is `false`, its sound is that of `Browser.layerSound`.
 *   `Sound.plugin` opens it when the app is made, wherever the layer is
 *   provided, and keeps it open until the app is closed. The apps made under
 *   the layer share it.
 *
 * @category Layers
 */
export const layer = (options: Options = {}): Layer.Layer<never> =>
  page.layer(options);

/**
 * The parts of a page's audio that are used. The browser's `AudioContext`
 * satisfies it.
 *
 * @category Models
 */
export interface AudioLike {
  readonly destination: unknown;
  readonly state?: string;
  /** Its own clock, in seconds, which times fades. */
  readonly currentTime: number;
  createBufferSource(): {
    buffer: unknown;
    loop: boolean;
    readonly playbackRate: { value: number };
    connect(to: unknown): unknown;
    start(): void;
    stop(when?: number): void;
  };
  createGain(): {
    readonly gain: {
      value: number;
      setValueAtTime(value: number, time: number): unknown;
      linearRampToValueAtTime(value: number, time: number): unknown;
      cancelScheduledValues(time: number): unknown;
    };
    connect(to: unknown): unknown;
  };
  /** Routes a streamed track's player into the audio graph, so it fades like any track. */
  createMediaElementSource?(media: unknown): { connect(to: unknown): unknown };
  /** Stops its clock, and with it every sound, until resumed. */
  suspend?(): Promise<unknown>;
  resume?(): Promise<unknown>;
  close(): Promise<unknown>;
}

/**
 * The parts of a streamed track's player that are used. An `<audio>` element
 * satisfies it.
 *
 * @category Models
 */
export interface MediaLike {
  loop: boolean;
  play(): Promise<unknown>;
  pause(): void;
}

/**
 * Makes a streamed track, a `Sound.Clip` that holds only its file's URL. When
 * a channel plays it, the page fetches and decodes it progressively. A file
 * given by URL, and one made with `Browser.sound`, are fetched whole and kept
 * decoded instead. A long piece of music takes tens of megabytes that way,
 * and a few hundred kilobytes streamed.
 *
 *   // By name, for the page's whole lifetime:
 *   Browser.runMain(game, { sounds: { theme: Browser.stream("/theme.ogg") } })
 *
 *   // Or directly, where a level's music is chosen:
 *   const ForestTheme = Browser.stream("/forest.ogg")
 *   const Score = Sound.music("game/Score", function*() {
 *     return (yield* Level).value === "forest" ? ForestTheme : undefined
 *   })
 *
 * **Details**
 *
 * - It isn't an asset and belongs to no bundle. Nothing is fetched until it
 *   plays, so there is nothing to load or release, and it doesn't go through
 *   `Assets.Loader`. A test plays `Sound.clip(name)` instead.
 * - It is for a channel's track. Played as a cue, it is logged once through
 *   Effect's logger and not played, since a cue must sound immediately.
 * - It starts, fades and stops like any track, and with `once` plays to its
 *   end. A looping stream may have an audible seam where it loops, so load a
 *   short piece that must loop seamlessly with `Browser.sound`, which decodes
 *   it whole.
 *
 * @category Constructors
 */
export const stream = (url: string): Sound.Clip => audio.stream(url);

/**
 * Returns a layer that plays a page's sound with Web Audio: the page's named
 * sound files for its whole lifetime, and the clips in a level's bundle.
 *
 *   Browser.layerSound({ coin: "/coin.wav", theme: "/theme.ogg" })
 *
 * **Details**
 *
 * - It opens nothing when it is built. `Sound.plugin` opens it when the app
 *   is made, wherever the layer is provided, and the page is heard until the
 *   app is closed. Playing it after that throws, with an error that says so.
 * - The page's audio belongs to the page, not to one app. The apps made under
 *   one `Effect.provide` of the layer share one audio context, since a
 *   browser lets a page have only a few, and each file is fetched once. The
 *   audio starts when the first of those apps opens it. When the last is
 *   closed, the audio context is closed, pending file requests are
 *   cancelled, and the page is no longer listened to.
 * - The files are fetched through `Assets.Loader` when the audio starts, and
 *   decoded as they arrive.
 * - A page can't play sound before the user interacts with it. The audio
 *   context is created on the first key or pointer press, and a cue requested
 *   in the very next frame plays. A cue requested before that, or before its
 *   file arrived, doesn't play, since a late sound is worse than none. The
 *   first cue requested before the first interaction is logged once through
 *   Effect's logger, so a game that opens with a sound learns why it isn't
 *   heard.
 * - A cue plays only while the audio is running. While the audio is
 *   suspended, or still resuming for a moment after the page becomes visible
 *   again, a cue is dropped, as one before the first interaction is. Started
 *   then, it would be delayed and play all at once with every other delayed
 *   cue.
 * - Music is never late, since it is what should be playing. A track
 *   requested before the first interaction, or before its file arrived,
 *   starts as soon as it can. It loops, or plays once to its end if
 *   requested, and a change of track or volume fades over the requested
 *   duration.
 * - A cue or a track without a file, or whose file couldn't be fetched or
 *   decoded, is logged once through Effect's logger, and plays nothing.
 * - While its display, `Driver.Display`, reports the page as hidden, the
 *   audio is suspended, music included, and it resumes when the page is
 *   visible again. The frame loop is paused then, and a frozen game should be
 *   silent. `Browser.layer` provides the page's display.
 * - A page without Web Audio plays nothing.
 *
 * @category Layers
 */
export const layerSound = (
  files: Readonly<Record<string, string | Sound.Clip>> = {},
  options: Pick<
    Options,
    "audio" | "decode" | "media" | "volume" | "window"
  > = {}
): Layer.Layer<never> => audio.layerSound(files, options);

/**
 * Makes a sound asset, a `Sound.Clip` decoded and ready to play, which a
 * bundle loads with the rest of a level's assets. A cue or a track can play
 * it wherever it takes a sound's name.
 *
 *   const Forest = Assets.bundle("game/Forest", {
 *     chirp: Browser.sound("/chirp.wav"),
 *     theme: Browser.sound("/forest.ogg"),
 *   })
 *
 * **When to use**
 *
 * Use for a cue, or for a track that is short or must loop seamlessly. For a
 * long piece of music, use `Browser.stream`, which isn't decoded whole.
 *
 * **Details**
 *
 * - It is decoded whole into memory as it arrives, so a long track takes
 *   memory in proportion to its length.
 * - Once its bundle is released, the bundle no longer plays it. Whatever is
 *   still sounding plays to its end, or until its channel changes, and is
 *   freed afterwards.
 *
 * @category Constructors
 */
export const sound = (url: string): Assets.Asset<Sound.Clip> =>
  media.sound(url);

/**
 * Makes an image asset, an `ImageBitmap` decoded and ready to draw, which is
 * closed when the scope it was loaded in closes.
 *
 *   const Forest = Assets.bundle("game/Forest", {
 *     backdrop: Browser.image("/forest.png"),
 *   })
 *
 * @category Constructors
 */
export const image = (url: string): Assets.Asset<ImageBitmap> =>
  media.image(url);

/**
 * Runs a game in a page, with the platform's `runMain`,
 * `BrowserRuntime.runMain`, and with `Browser.layer(options)` provided to the
 * whole program.
 *
 *   Browser.runMain(Driver.run(App.define({ plugins: [Game] }), { hz: 60 }), { target: canvas })
 *
 * **Details**
 *
 * - The game must have no remaining requirements. Provide your game's own
 *   services to it first, since a missing one is a compile error here.
 * - A failure is reported through Effect's logger.
 * - When the page is closed for good, on a `pagehide` that doesn't enter the
 *   browser's back-forward cache, the game is interrupted. The frame loop
 *   stops, `Driver.run` closes the app, and the page is no longer listened
 *   to.
 *
 * @category Running
 */
export const runMain = <A, E>(
  game: Effect.Effect<A, E>,
  options: Options & {
    /** Disables error reporting. */
    readonly disableErrorReporting?: boolean;
    /** What to do when the game ends. Defaults to nothing. */
    readonly teardown?: Runtime.Teardown;
  } = {}
): void =>
  BrowserRuntime.runMain(Effect.provide(game, layer(options)), {
    disableErrorReporting: options.disableErrorReporting,
    teardown: options.teardown,
  });
