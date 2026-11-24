import type * as Sound from "../Sound";

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
