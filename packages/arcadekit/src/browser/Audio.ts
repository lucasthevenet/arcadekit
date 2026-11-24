/**
 * The page's sound, played with Web Audio: the page's own sound files, the
 * clips in a level's bundle, and tracks streamed as they play.
 * `arcadekit/browser/Browser` gives all of it too, as `Browser.layerSound`,
 * `Browser.sound` and `Browser.stream`.
 *
 *   import * as Audio from "arcadekit/browser/Audio"
 *
 *   Browser.runMain(game, {
 *     sounds: { coin: "/coin.wav", theme: Audio.stream("/theme.ogg") },
 *   })
 *
 * A page makes no sound until its user has pressed a key or a button.
 * `Audio.layerSound` says what is played before then, and what after.
 */
import type { Layer } from "effect";

import type * as Assets from "../Assets";
import type * as Sound from "../Sound";
import type { Options } from "./Browser";
import * as audio from "./internal/audio";
import * as decode from "./internal/decode";

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
  decode.sound(url);
