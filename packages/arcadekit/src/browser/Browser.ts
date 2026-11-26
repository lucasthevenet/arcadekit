/**
 * Everything that only a page can use: its display, its input devices, its
 * images and sound, and the way a program starts in it. `arcadekit/browser`
 * is the only entry point that imports a browser package, so a server, a
 * replay or a test of the game imports `arcadekit` alone.
 *
 *   import { App, Driver } from "arcadekit"
 *   import * as Browser from "arcadekit/browser/Browser"
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

import type * as Assets from "../Assets.ts";
import type * as Driver from "../Driver.ts";
import type * as Input from "../Input.ts";
import type * as Save from "../Save.ts";
import type * as Setting from "../Setting.ts";
import type * as Sound from "../Sound.ts";
import type { ContextLike, MediaLike } from "./Audio.ts";
import * as decode from "./internal/decode.ts";
import * as page from "./internal/page.ts";
import * as storage from "./internal/storage.ts";

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
  readonly preventDefault?: readonly Input.KeyCode[];
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
   * The cue sheets whose files the page plays for its whole lifetime, made
   * with `Sound.sheet`, as `Audio.layerSound` takes them. Their files are
   * fetched and decoded. When omitted, the page still plays the sounds in a
   * level's bundle, made with `Audio.sound`, and the streams of a sheet.
   * `false` means no sound at all. No audio context is created, and the game
   * is told that nothing is heard.
   */
  readonly sounds?: readonly Sound.Sheet[] | false;
  /**
   * The master volume, which scales every bus. Defaults to 1, the volume the
   * game requests. A game's own settings set a bus's volume with
   * `Sound.Player`'s `volume` instead.
   */
  readonly volume?: number;
  /** Creates the page's audio context. Defaults to `new AudioContext()`. */
  readonly audio?: () => ContextLike;
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
 *   `Assets.layer(Assets.makeMemory(files))`, is provided around this layer.
 * - Each app listens to the devices for itself, from when `App.make` makes
 *   the app until the app is closed, wherever the layer is provided. Reading
 *   the devices after the app is closed throws, with an error that says so.
 * - Unless `sounds` is `false`, its sound is that of `Audio.layerSound`.
 *   `Sound.plugin` opens it when the app is made, wherever the layer is
 *   provided, and keeps it open until the app is closed. The apps made under
 *   the layer share it.
 *
 * @category Layers
 */
export const layer = (options: Options = {}): Layer.Layer<never> =>
  page.layer(options);

/**
 * Where a page keeps a game's saves: its local storage, under the game's
 * name, so that two games of one site keep apart. Give it to `Save.layer`.
 *
 *   Effect.provide(Save.layer(Browser.saves("mygame")))
 *
 * **Gotchas**
 *
 * - A page's local storage holds about 5 MB for its whole site, and a save
 *   is kept there as base64 text, a third larger than its bytes. A save that
 *   doesn't fit fails `Save.write` with `Save.StoreFailed`.
 *
 * @category Services
 */
export const saves = (name: string): Save.StoreShape => storage.saves(name);

/**
 * Where a page keeps a game's settings: its local storage, under the game's
 * name. Give it to `Setting.layer`. A setting is read from the storage the
 * first time it is asked for, and from memory after.
 *
 *   Effect.provide(Setting.layer(Browser.settings("mygame")))
 *
 * @category Services
 */
export const settings = (name: string): Setting.StoreShape =>
  storage.settings(name);

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
  decode.image(url);

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
