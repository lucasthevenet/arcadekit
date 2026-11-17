/**
 * What only a page can use: its display, its devices, its pictures, its
 * sound, and the way a program is started in it. This is the package's `arcadekit/Browser`
 * entry, and the only one that imports a browser package. A server, a
 * replay or a test of the game imports `arcadekit` alone.
 *
 *   import { App } from "arcadekit"
 *   import * as Browser from "arcadekit/Browser"
 *
 *   Browser.runMain(App.run({ plugins: [Game] }, { hz: 60 }), {
 *     target: canvas,
 *     preventDefault: ["Space", "ArrowUp", "ArrowDown"],
 *   })
 *
 * `Browser.runMain` is the platform's `runMain` around the game, with the
 * page's display and devices provided to the whole of it: the frame loop
 * follows `requestAnimationFrame`, the input stage hears the keyboard, the
 * pointer and the gamepads, and when the page goes away the game is
 * interrupted and everything is let go.
 */
import * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";
import { Effect, Layer } from "effect";
import type { Runtime } from "effect";

import * as Assets from "./Assets";
import * as Driver from "./Driver";
import * as Input from "./Input";
import * as Sound from "./Sound";

const describe = (error: unknown): string =>
  error instanceof Error ? error.message || error.name : String(error);

// --- the display ---------------------------------------------------------------

/**
 * A page's screen: a frame is due once per repaint
 * (`requestAnimationFrame`), and nobody can see the game while the
 * document is hidden. It holds nothing.
 *
 * @category Services
 */
export const display: Driver.DisplayShape = {
  request(callback) {
    const id = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(id);
  },
  hidden: () => document.visibilityState === "hidden",
  onVisibilityChange(listener) {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
};

// --- the devices ---------------------------------------------------------------

/**
 * As much of a gamepad as is read: the browser's `Gamepad` is one.
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
 * As much of an element as the pointer is measured against.
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
 * How `Browser.runMain` and `Browser.layer` connect a game to the page:
 * what the pointer is measured against, the gamepads, and sound.
 *
 * @category Options
 */
export interface Options {
  /**
   * What the pointer is pressed on, and what its place is measured from:
   * `PointerX` and `PointerY` are CSS pixels from its top left corner.
   * The window, when left out.
   */
  readonly target?: PointerTarget;
  /**
   * The codes of the keys whose usual effect in the page is prevented, such
   * as the arrows and the space bar, which scroll it.
   */
  readonly preventDefault?: readonly string[];
  /**
   * How far from its middle a gamepad's axis has to be to count: nearer
   * than this is 0. The default is 0.1. What counts is rounded to two
   * decimals, so that a stick held still does not report every frame.
   */
  readonly deadzone?: number;
  /** Where keys and the pointer's moves are listened for. The window, when left out. */
  readonly window?: EventTarget;
  /** The gamepads, read once per sample. `navigator.getGamepads`, when left out. */
  readonly gamepads?: () => ArrayLike<GamepadLike | null>;
  /**
   * The sounds the page has for as long as it lasts, by the name a cue or
   * a track is played by, as `Browser.layerSound` takes them: each the URL
   * of a file, which is fetched and decoded, or a clip, such as
   * `Browser.stream(url)` for a long piece of music. Left out, the page
   * still plays the sounds a level's bundle holds, `Browser.sound`.
   * `false` is a page with no sound at all: no audio is made, and the
   * game is told that nothing is heard.
   */
  readonly sounds?: Readonly<Record<string, string | Sound.Clip>> | false;
  /** How loud everything is played: 1, as it asks, when left out. */
  readonly volume?: number;
  /** Makes the page's audio. `new AudioContext()`, when left out. */
  readonly audio?: () => AudioLike;
  /**
   * Makes a sound of a file's bytes. `decodeAudioData`, of a context that
   * plays nothing and so needs no touch, when left out.
   */
  readonly decode?: (data: ArrayBuffer) => Promise<unknown>;
  /**
   * Makes what plays a streamed track, of its URL. An `<audio>` element,
   * when left out.
   */
  readonly media?: (url: string) => MediaLike;
}

const isPad = (code: string): boolean => code.startsWith("Pad");
const isPointer = (code: string): boolean => code.startsWith("Pointer");

const listen = (
  options: Options
): { readonly source: Input.SourceShape; readonly stop: () => void } => {
  const state = Input.makeManualSource();
  const page: EventTarget = options.window ?? globalThis;
  const target: PointerTarget = options.target ?? page;
  const prevented = new Set(options.preventDefault ?? []);
  const deadzone = options.deadzone ?? 0.1;
  const gamepads =
    options.gamepads ??
    ((): ArrayLike<GamepadLike | null> =>
      typeof navigator !== "undefined" &&
      typeof navigator.getGamepads === "function"
        ? navigator.getGamepads()
        : []);
  const stops: (() => void)[] = [];
  const on = <E extends Event>(
    where: EventTarget,
    type: string,
    listener: (event: E) => void
  ): void => {
    where.addEventListener(type, listener as EventListener);
    stops.push(() =>
      where.removeEventListener(type, listener as EventListener)
    );
  };
  on(page, "keydown", (event: KeyboardEvent) => {
    if (prevented.has(event.code)) {
      event.preventDefault();
    }
    // A key held down repeats; it went down once.
    if (!event.repeat) {
      state.press(event.code);
    }
  });
  on(page, "keyup", (event: KeyboardEvent) => {
    if (prevented.has(event.code)) {
      event.preventDefault();
    }
    state.release(event.code);
  });
  // A page that loses the keyboard is not told when a key goes up.
  on(page, "blur", () => state.releaseAll((code) => !isPad(code)));
  const place = (event: PointerEvent): void => {
    const box = target.getBoundingClientRect?.();
    state.move(Input.pointerX, event.clientX - (box?.left ?? 0));
    state.move(Input.pointerY, event.clientY - (box?.top ?? 0));
  };
  // A page reports one press, when the first button goes down, and one
  // release, when the last goes up. A button that changes while another is
  // held comes as a move, and `buttons` says which are down by then: a bit
  // each, in an order of their own.
  const BITS: readonly (readonly [bit: number, button: number])[] = [
    [1, 0],
    [2, 2],
    [4, 1],
    [8, 3],
    [16, 4],
  ];
  // Whether a press on the target began what is held now.
  let held = false;
  const letGo = (): void => {
    held = false;
    state.releaseAll(isPointer);
  };
  /** Makes the buttons that are down the ones the page says are. */
  const follow = (buttons: number): void => {
    for (const [bit, button] of BITS) {
      const code = Input.pointerButton(button);
      if ((buttons & bit) === 0) {
        state.release(code);
      } else {
        state.press(code);
      }
    }
  };
  on(target, "pointerdown", (event: PointerEvent) => {
    place(event);
    held = true;
    state.press(Input.pointerButton(event.button));
    if (event.buttons > 0) {
      follow(event.buttons);
    }
  });
  // On the page, so that a button let go outside the target is let go.
  on(page, "pointermove", (event: PointerEvent) => {
    place(event);
    if (!held || typeof event.buttons !== "number") {
      return;
    }
    if (event.buttons === 0) {
      // Let go where the page could not hear of it.
      letGo();
    } else {
      follow(event.buttons);
    }
  });
  on(page, "pointerup", (event: PointerEvent) => {
    place(event);
    state.release(Input.pointerButton(event.button));
    if (event.buttons === 0) {
      letGo();
    } else if (event.buttons > 0) {
      follow(event.buttons);
    }
  });
  on(page, "pointercancel", letGo);

  // Gamepads send no events worth having: they are read when sampled.
  let known = new Set<string>();
  const round = (value: number): number =>
    Math.abs(value) < deadzone ? 0 : Math.round(value * 100) / 100;
  const readPads = (): void => {
    const seen = new Set<string>();
    const pads = gamepads();
    for (let p = 0; p < pads.length; p++) {
      const pad = pads[p];
      if (pad === null || pad === undefined || !pad.connected) {
        continue;
      }
      for (let b = 0; b < pad.buttons.length; b++) {
        const code = Input.padButton(pad.index, b);
        seen.add(code);
        if (pad.buttons[b]!.pressed) {
          state.press(code);
        } else {
          state.release(code);
        }
      }
      for (let a = 0; a < pad.axes.length; a++) {
        const code = Input.padAxis(pad.index, a);
        seen.add(code);
        state.move(code, round(pad.axes[a]!));
      }
    }
    // A gamepad that was unplugged lets go of everything.
    for (const code of known) {
      if (!seen.has(code)) {
        state.release(code);
        state.move(code, 0);
      }
    }
    known = seen;
  };
  let stopped = false;
  return {
    source: {
      sample() {
        if (stopped) {
          throw new Error(
            "The page's devices were read after Browser.layer was let go: its listeners are gone, so it would say nothing for ever. A layer lasts as long as what it is provided to. Provide it to the whole program, as Browser.runMain does, or with App.run(...).pipe(Effect.provide(Browser.layer())), not to App.make alone."
          );
        }
        readPads();
        return state.sample();
      },
    },
    stop() {
      stopped = true;
      for (const stop of stops) {
        stop();
      }
    },
  };
};

/**
 * A page's display and its devices, for the whole of a program.
 *
 * - The frame loop follows `requestAnimationFrame`, and pauses while the
 *   document is hidden.
 * - A key's code is `KeyboardEvent.code`. A key held down went down once,
 *   and every key and pointer button goes up when the page loses focus.
 * - `PointerX` and `PointerY` are CSS pixels from the top left of `target`.
 *   Presses are heard on `target`, moves and releases on the whole page.
 * - Gamepads are read when the app samples, once per tick.
 * - It listens from when it is built until its scope closes, so provide it
 *   to the whole program and not to `App.make` alone. `Browser.runMain`
 *   does.
 *
 * @category Layers
 */
export const layer = (options: Options = {}): Layer.Layer<never> => {
  const page = Layer.merge(
    Layer.succeed(Driver.Display, display),
    Layer.effect(
      Input.Source,
      Effect.map(
        Effect.acquireRelease(
          Effect.sync(() => listen(options)),
          (listening) => Effect.sync(listening.stop)
        ),
        (listening) => listening.source
      )
    )
  ) as Layer.Layer<never>;
  return options.sounds === false
    ? page
    : Layer.merge(
        page,
        // Its sound sleeps while the page's own document is hidden.
        Layer.provide(
          layerSound(options.sounds ?? {}, options),
          Layer.succeed(Driver.Display, display)
        )
      );
};

// --- sound -----------------------------------------------------------------------

/**
 * As much of a page's audio as is used: the browser's `AudioContext` is one.
 *
 * @category Models
 */
export interface AudioLike {
  readonly destination: unknown;
  readonly state?: string;
  /** Its own clock, in seconds: what a fade is timed by. */
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
  /** Brings what a streamed track plays into the audio, so that it is faded as any track is. */
  createMediaElementSource?(media: any): { connect(to: unknown): unknown };
  /** Stops its clock, and with it everything that sounds, until it is resumed. */
  suspend?(): Promise<unknown>;
  resume?(): Promise<unknown>;
  close(): Promise<unknown>;
}

/**
 * As much of what plays a streamed track as is used: an `<audio>` element is one.
 *
 * @category Models
 */
export interface MediaLike {
  loop: boolean;
  play(): Promise<unknown>;
  pause(): void;
}

/** What a clip that is streamed holds: where it is, and nothing of it. */
class Streamed {
  constructor(readonly url: string) {}
}

/**
 * A track that is streamed: a `Sound.Clip` that holds only where its file
 * is. Played on a channel, the page fetches it as it plays and decodes it
 * as it goes, where a file given by its URL, and `Browser.sound`, are
 * fetched whole and held decoded: a long piece of music is tens of
 * megabytes that way, and a few hundred kilobytes this.
 *
 *   // By a name, for as long as the page lasts:
 *   Browser.runMain(game, { sounds: { theme: Browser.stream("/theme.ogg") } })
 *
 *   // Or as it is, where a level's music is said:
 *   const ForestTheme = Browser.stream("/forest.ogg")
 *   const Score = Sound.music("game/Score", function*() {
 *     return (yield* Level).value === "forest" ? ForestTheme : undefined
 *   })
 *
 * - It is no asset, and is in no bundle: nothing is fetched until it is
 *   played, so there is nothing to load and nothing to let go, and it does
 *   not come through `Assets.Loader`. A test plays `Sound.clip(name)`.
 * - It is for a channel's track. Played as a cue it is said once, through
 *   Effect's logger, and not played: a cue is to be heard at once.
 * - Started, faded and stopped as any track, and with `once` played to its
 *   end. One that goes round may be heard to join where it does: a short
 *   piece that has to go round without a seam is better decoded.
 *
 * @category Constructors
 */
export const stream = (url: string): Sound.Clip =>
  Sound.clip(url, new Streamed(url));

const audioElement = (url: string): MediaLike => {
  const element = new Audio();
  // Asked for before the address is given: a file from elsewhere that
  // may be shared is then heard, where it would be silence.
  element.crossOrigin = "anonymous";
  element.preload = "auto";
  element.src = url;
  return element;
};

// Decoding needs no touch, only playing does: a context that plays nothing
// decodes a file as soon as it is there.
const decodeOffline = (data: ArrayBuffer): Promise<unknown> =>
  new OfflineAudioContext(1, 1, 44_100).decodeAudioData(data);

/** One channel of music: what it is to play, and what it is playing. */
interface Channel {
  wanted:
    | {
        readonly track: Sound.Playable;
        readonly volume: number;
        /** Whether it plays to its end and no further. */
        readonly once: boolean;
      }
    | undefined;
  /** How many seconds the change that was last asked for takes. */
  fade: number;
  playing:
    | {
        readonly track: Sound.Playable;
        readonly gain: ReturnType<AudioLike["createGain"]>;
        /** Says whether it goes round, or plays to its end and no further. */
        readonly loop: (on: boolean) => void;
        /** Stops it, `fade` seconds from `now`, which is when it is silent. */
        readonly end: (now: number, fade: number) => void;
      }
    | undefined;
}

/**
 * A page's sound, played with Web Audio: the sounds it has for as long as
 * it lasts, each a file with a name, and the clips a level's bundle holds.
 *
 *   Browser.layerSound({ coin: "/coin.wav", theme: "/theme.ogg" })
 *
 * - The files are fetched when the layer is built, through
 *   `Assets.Loader`, and decoded as they arrive.
 * - A page may not make a sound before its user has touched it. The audio
 *   is made at the first key or pointer press, and a cue asked for in the
 *   very frame after is played. A cue that was asked for before that, or
 *   before its file was there, is not played: a sound that is late is
 *   worse than none. The first cue that comes before the first touch is
 *   said, once, through Effect's logger, so that a game which opens with
 *   a sound is told why it is not heard.
 * - A cue is played only by audio that is running. While it sleeps, or
 *   is still waking, which takes a moment when the page is seen again,
 *   a cue is dropped, as one before the first touch is: started then, it
 *   would wait and be heard with every other that waited, all at once.
 * - Music is not late, it is what should be playing: a track that was
 *   asked for before the first touch, or before its file was there, starts
 *   when it can. It plays over and over, or once to its end if it was
 *   asked so, and a change of track or of volume is a fade of as long as
 *   was asked.
 * - A cue or a track that has no file, or whose file could not be fetched
 *   or decoded, is said once, through Effect's logger, and plays nothing.
 * - While the display it is given, `Driver.Display`, says the page is
 *   hidden, the audio is put to sleep, music and all, and woken when the
 *   page is seen again: the frame loop rests then, and a game that stands
 *   still is not heard. `Browser.layer` gives it the page's.
 * - A page with no Web Audio plays nothing.
 * - When its scope closes the audio is closed and the page is no longer
 *   listened to, so it is provided to the whole program. `Browser.runMain`
 *   and `Browser.layer` do, unless told `sounds: false`.
 *
 * @category Layers
 */
export const layerSound = (
  files: Readonly<Record<string, string | Sound.Clip>> = {},
  options: Pick<
    Options,
    "audio" | "decode" | "media" | "volume" | "window"
  > = {}
): Layer.Layer<never> =>
  Layer.effect(
    Sound.Output,
    Effect.gen(function* () {
      const loader = yield* Assets.Loader;
      const report = Effect.runForkWith(yield* Effect.context<never>());
      const page: EventTarget = options.window ?? globalThis;
      const make =
        options.audio ??
        (typeof AudioContext === "undefined"
          ? undefined
          : (): AudioLike => new AudioContext());
      const master = options.volume ?? 1;
      const decode = options.decode ?? decodeOffline;
      const media = options.media ?? audioElement;
      // What is being streamed now, to be stopped with the page's audio
      // and started with it, and what waits to stop one.
      const streaming = new Set<MediaLike>();
      const timers = new Set<ReturnType<typeof setTimeout>>();
      const buffers = new Map<string, unknown>();
      const missing = new Set<string>();
      const channels = new Map<string, Channel>();
      const display = yield* Driver.Display;
      let audio: AudioLike | undefined;
      let unwatch: (() => void) | undefined;
      let closed = false;
      // Whether it was said that a cue came before the first touch.
      let early = false;
      const failed = (cue: string, error: unknown): void => {
        report(
          Effect.logWarning(
            `The sound "${cue}" (${String(files[cue])}) will not be played: ${describe(error)}`
          )
        );
      };
      /** What is played for a name or a clip, if it is there to play. */
      const bufferOf = (sound: Sound.Playable): unknown => {
        if (typeof sound !== "string") {
          return sound.data;
        }
        if (!Object.hasOwn(files, sound)) {
          if (!missing.has(sound)) {
            missing.add(sound);
            report(
              Effect.logWarning(
                `The sound "${sound}" was played and has no file. The page's sounds are: ${Object.keys(files).join(", ") || "none"}.`
              )
            );
          }
          return undefined;
        }
        // A name is a file that was decoded, or a clip under that name.
        const file = files[sound]!;
        return typeof file === "string" ? buffers.get(sound) : file.data;
      };
      /** Starts a streamed track, silent, on a volume of its own. */
      const startStream = (
        context: AudioLike,
        streamed: Streamed,
        once: boolean,
        gain: ReturnType<AudioLike["createGain"]>
      ): Pick<NonNullable<Channel["playing"]>, "end" | "loop"> | undefined => {
        if (context.createMediaElementSource === undefined) {
          if (!missing.has(streamed.url)) {
            missing.add(streamed.url);
            report(
              Effect.logWarning(
                `The sound "${streamed.url}" is streamed, and the page's audio cannot take a stream: it will not be played.`
              )
            );
          }
          return undefined;
        }
        const element = media(streamed.url);
        element.loop = !once;
        context.createMediaElementSource(element).connect(gain);
        streaming.add(element);
        // It may not be there, or not be a sound: said once, as of a file.
        element.play().catch((error: unknown) => {
          if (!closed && !missing.has(streamed.url)) {
            missing.add(streamed.url);
            report(
              Effect.logWarning(
                `The sound "${streamed.url}" will not be played: ${describe(error)}`
              )
            );
          }
        });
        const stop = (): void => {
          streaming.delete(element);
          element.pause();
        };
        return {
          loop: (on) => {
            element.loop = on;
          },
          // What plays it has no clock to be told a time on: it is stopped
          // when the time has gone.
          end: (_now, fade) => {
            if (fade <= 0) {
              stop();
              return;
            }
            const timer = setTimeout(() => {
              timers.delete(timer);
              stop();
            }, fade * 1000);
            timers.add(timer);
          },
        };
      };
      /** Brings a channel from what it is playing to what it is to play. */
      const settle = (channel: Channel): void => {
        if (audio === undefined) {
          return;
        }
        const { fade, playing, wanted } = channel;
        const now = audio.currentTime;
        if (playing !== undefined && playing.track !== wanted?.track) {
          const level = playing.gain.gain;
          level.cancelScheduledValues(now);
          level.setValueAtTime(level.value, now);
          level.linearRampToValueAtTime(0, now + fade);
          playing.end(now, fade);
          channel.playing = undefined;
        }
        if (wanted === undefined) {
          return;
        }
        if (channel.playing === undefined) {
          const buffer = bufferOf(wanted.track);
          // Not here yet: it starts when its file is.
          if (buffer === undefined) {
            return;
          }
          const gain = audio.createGain();
          // Silent, and on its way to its volume, before it is started.
          gain.gain.setValueAtTime(0, now);
          gain.gain.linearRampToValueAtTime(wanted.volume * master, now + fade);
          let started: Pick<NonNullable<Channel["playing"]>, "end" | "loop">;
          if (buffer instanceof Streamed) {
            const stream = startStream(audio, buffer, wanted.once, gain);
            if (stream === undefined) {
              return;
            }
            gain.connect(audio.destination);
            started = stream;
          } else {
            const source = audio.createBufferSource();
            source.buffer = buffer;
            source.loop = !wanted.once;
            source.connect(gain);
            gain.connect(audio.destination);
            source.start();
            started = {
              loop: (on) => {
                source.loop = on;
              },
              end: (at, after) => source.stop(at + after),
            };
          }
          channel.playing = { track: wanted.track, gain, ...started };
        } else {
          // The same track, louder or softer, and over and over or not.
          channel.playing.loop(!wanted.once);
          const level = channel.playing.gain.gain;
          level.cancelScheduledValues(now);
          level.setValueAtTime(level.value, now);
          level.linearRampToValueAtTime(wanted.volume * master, now + fade);
        }
      };
      const settleAll = (): void => {
        for (const channel of channels.values()) {
          settle(channel);
        }
      };
      // Every file at once, for as long as the layer lasts: a request that
      // is still on its way when the scope closes is given up.
      yield* Effect.forkScoped(
        Effect.forEach(
          // A name that is a clip's has no file to fetch.
          Object.entries(files).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          ),
          ([cue, url]) =>
            Effect.match(loader.bytes(url), {
              onSuccess: (bytes) => {
                // A copy: decoding keeps the buffer it is given.
                decode(bytes.slice().buffer).then(
                  (buffer) => {
                    if (!closed) {
                      buffers.set(cue, buffer);
                      // A channel may have been waiting for it.
                      settleAll();
                    }
                  },
                  (error: unknown) => failed(cue, error)
                );
              },
              onFailure: (error) => failed(cue, error.message),
            }),
          { concurrency: "unbounded", discard: true }
        )
      );
      // The first touch makes the audio; a later one wakes it, should the
      // browser have put it to sleep.
      const wake = (): void => {
        if (audio === undefined) {
          audio = make?.();
          if (audio !== undefined) {
            // Hidden, nobody plays the game and its frame loop rests: what
            // is heard rests with it. Watched from now on, since before
            // there is audio there is nothing to put to sleep.
            unwatch = display.onVisibilityChange(() => {
              // What is streamed keeps its own time, and is stopped and
              // started with the audio it plays into.
              if (display.hidden()) {
                void audio?.suspend?.();
                for (const element of streaming) {
                  element.pause();
                }
              } else {
                void audio?.resume?.();
                for (const element of streaming) {
                  element.play().catch(() => {});
                }
              }
            });
          }
          // What should have been playing all along starts now.
          settleAll();
        } else if (audio.state !== undefined && audio.state !== "running") {
          // Asleep for whatever reason, the browser's own among them.
          void audio.resume?.();
        }
      };
      const touches = ["pointerdown", "keydown"];
      for (const type of touches) {
        page.addEventListener(type, wake);
      }

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed = true;
          for (const type of touches) {
            page.removeEventListener(type, wake);
          }
          unwatch?.();
          for (const timer of timers) {
            clearTimeout(timer);
          }
          timers.clear();
          for (const element of streaming) {
            element.pause();
          }
          streaming.clear();
          buffers.clear();
          channels.clear();
          void audio?.close();
          audio = undefined;
        })
      );
      return {
        play(cue, volume, rate) {
          const buffer = bufferOf(cue);
          // Before the first touch, before the file is here, or after
          // the layer was let go, which empties the buffers.
          if (audio === undefined || buffer === undefined) {
            // Before the first touch, on a page that could play it after:
            // said once, since nothing else tells why a game that opens
            // with a sound is not heard.
            if (
              audio === undefined &&
              !closed &&
              make !== undefined &&
              !early
            ) {
              early = true;
              report(
                Effect.logInfo(
                  `The cue "${typeof cue === "string" ? cue : cue.name}" was asked for before the page was touched, and is not played: a browser lets a page make no sound until its user has pressed a key or a button, and a cue that came late would be worse than none. A track asked for then starts at the first touch. This is said once.`
                )
              );
            }
            return;
          }
          // Asleep, or still waking, as it is for a moment after the page
          // is seen again: a cue started now would wait, and be heard with
          // every other that waited, all at once, when the audio wakes.
          if (audio.state !== undefined && audio.state !== "running") {
            return;
          }
          if (buffer instanceof Streamed) {
            // To be heard at once, a cue is decoded and waiting.
            if (!missing.has(buffer.url)) {
              missing.add(buffer.url);
              report(
                Effect.logWarning(
                  `The sound "${buffer.url}" is streamed, which is for a channel's track: as a cue it is not played. A cue is a file given by its URL, or Browser.sound.`
                )
              );
            }
            return;
          }
          const source = audio.createBufferSource();
          source.buffer = buffer;
          source.playbackRate.value = rate;
          const gain = audio.createGain();
          gain.gain.value = volume * master;
          source.connect(gain);
          gain.connect(audio.destination);
          source.start();
        },
        music(name, track, volume, fade, once) {
          let channel = channels.get(name);
          if (channel === undefined) {
            channel = { wanted: undefined, fade, playing: undefined };
            channels.set(name, channel);
          }
          channel.wanted =
            track === undefined
              ? undefined
              : { track, volume, once: once === true };
          channel.fade = fade;
          settle(channel);
        },
      };
    })
  ) as Layer.Layer<never>;

/**
 * An asset that is a sound, decoded and ready to play: a `Sound.Clip`, in
 * a bundle with the rest of a level's, and played wherever a cue's or a
 * track's name would be.
 *
 *   const Forest = Assets.bundle("game/Forest", {
 *     chirp: Browser.sound("/chirp.wav"),
 *     theme: Browser.sound("/forest.ogg"),
 *   })
 *
 * - It is decoded whole, into memory, as it arrives: a long track is as
 *   large there as it is long.
 * - Let go with its bundle, it is no longer the bundle's to play; what is
 *   still sounding of it plays to its end, or until its channel is told
 *   otherwise, and is freed after.
 *
 * @category Constructors
 */
export const sound = (url: string): Assets.Asset<Sound.Clip> =>
  Assets.make(url, (data, at) =>
    Effect.tryPromise({
      // A copy: decoding keeps the buffer it is given.
      try: async () => Sound.clip(at, await decodeOffline(data.slice().buffer)),
      catch: (error) =>
        new Assets.AssetFailed({
          url: at,
          message: `It could not be made a sound: ${describe(error)}`,
        }),
    })
  );

// --- pictures --------------------------------------------------------------------

/**
 * An asset that is a picture, decoded and ready to draw: an `ImageBitmap`,
 * closed when the scope it was loaded in closes.
 *
 *   const Forest = Assets.bundle("game/Forest", {
 *     backdrop: Browser.image("/forest.png"),
 *   })
 *
 * @category Constructors
 */
export const image = (url: string): Assets.Asset<ImageBitmap> =>
  Assets.make(url, (data, at) =>
    Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          // A copy: a Blob wants bytes that nothing else can change.
          createImageBitmap(new Blob([data.slice()])),
        catch: (error) =>
          new Assets.AssetFailed({
            url: at,
            message: `It could not be made a picture: ${describe(error)}`,
          }),
      }),
      (bitmap) => Effect.sync(() => bitmap.close())
    )
  );

// --- starting a program ------------------------------------------------------------

/**
 * Starts a game in a page. It is the platform's `runMain`
 * (`BrowserRuntime.runMain`) around the game, with `Browser.layer(options)`
 * provided to the whole of it.
 *
 *   Browser.runMain(App.run({ plugins: [Game] }, { hz: 60 }), { target: canvas })
 *
 * - The game is whatever needs nothing more from outside: provide the
 *   game's own services to it first, and a missing one is a compile error
 *   here.
 * - A failure is reported through Effect's logger.
 * - When the page goes away for good (`pagehide`, and not into the
 *   back/forward cache) the game is interrupted: the frame loop stops, the
 *   app's scope closes, and the page is no longer listened to.
 *
 * @category Running
 */
export const runMain = <A, E>(
  game: Effect.Effect<A, E>,
  options: Options & {
    /** Leaves a failure unreported. */
    readonly disableErrorReporting?: boolean;
    /** What to do when the game has ended, in place of nothing. */
    readonly teardown?: Runtime.Teardown;
  } = {}
): void =>
  BrowserRuntime.runMain(Effect.provide(game, layer(options)), {
    disableErrorReporting: options.disableErrorReporting,
    teardown: options.teardown,
  });
