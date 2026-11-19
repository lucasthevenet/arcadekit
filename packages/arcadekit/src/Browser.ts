/**
 * The `arcadekit/Browser` entry point: everything only a page can use, namely
 * its display, input devices, images and sound, and the way a program starts in
 * it. It is the only entry point that imports a browser package, so a server, a
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
 * `Browser.runMain` wraps the game in the platform's `runMain`, and provides
 * the page's display and devices to the whole program: the frame loop follows
 * `requestAnimationFrame`, the input stage reads the keyboard, the pointer and
 * gamepads, and when the page closes the game is interrupted and everything is
 * released.
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
 * A page's display: a frame is due once per repaint (`requestAnimationFrame`),
 * and the game is hidden while the document is. It holds no state.
 *
 * @category Services
 */
export const display: Driver.Display = {
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
 * The parts of a gamepad that are read; the browser's `Gamepad` satisfies it.
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
   * The element the pointer is pressed on and measured from: `PointerX` and
   * `PointerY` are CSS pixels from its top-left corner. Defaults to the window.
   */
  readonly target?: PointerTarget;
  /**
   * The codes of the keys whose default action in the page is prevented, such
   * as the arrows and the space bar, which scroll it.
   */
  readonly preventDefault?: readonly string[];
  /**
   * How far from center a gamepad axis must move to register; anything closer
   * reads as 0. Defaults to 0.1. Values are rounded to two decimals, so a stick
   * held still doesn't report every frame.
   */
  readonly deadzone?: number;
  /** Where key presses and pointer movement are listened for. Defaults to the window. */
  readonly window?: EventTarget;
  /** The gamepads, read once per sample. Defaults to `navigator.getGamepads`. */
  readonly gamepads?: () => Iterable<GamepadLike | null>;
  /**
   * The page's sounds for its whole lifetime, by the name a cue or a track is
   * played with, as `Browser.layerSound` takes them: each is either the URL of
   * a file, which is fetched and decoded, or a clip, such as
   * `Browser.stream(url)` for a long piece of music. When omitted, the page
   * still plays the sounds in a level's bundle, `Browser.sound`. `false` means
   * no sound at all: no audio context is created, and the game is told that
   * nothing is heard.
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

const isPad = (code: string): boolean => code.startsWith("Pad");
const isPointer = (code: string): boolean => code.startsWith("Pointer");

const listen = (
  options: Options
): { readonly source: Input.Source; readonly stop: () => void } => {
  const state = Input.makeManualSource();
  const page: EventTarget = options.window ?? globalThis;
  const target: PointerTarget = options.target ?? page;
  const prevented = new Set(options.preventDefault);
  const deadzone = options.deadzone ?? 0.1;

  const gamepads =
    options.gamepads ??
    ((): Iterable<GamepadLike | null> =>
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
    // SAFETY: the page calls a listener of `type` with that type's event,
    // which each call below names as E.
    const heard = listener as EventListener;
    where.addEventListener(type, heard);
    stops.push(() => where.removeEventListener(type, heard));
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

  /** Syncs the buttons held down with the ones the page reports. */
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

    for (const pad of pads) {
      if (pad === null || pad === undefined || !pad.connected) {
        continue;
      }

      for (let b = 0; b < pad.buttons.length; b += 1) {
        const code = Input.padButton(pad.index, b);
        seen.add(code);

        if (pad.buttons[b]!.pressed) {
          state.press(code);
        } else {
          state.release(code);
        }
      }

      for (let a = 0; a < pad.axes.length; a += 1) {
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

/** What a streamed clip holds: only its URL. */
class Streamed {
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }
}

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

/**
 * Returns a layer that plays a page's sound with Web Audio: the page's named
 * sound files for its whole lifetime, and the clips in a level's bundle.
 *
 *   Browser.layerSound({ coin: "/coin.wav", theme: "/theme.ogg" })
 *
 * - The files are fetched through `Assets.Loader` when the layer is built, and
 *   decoded as they arrive.
 * - A page can't play sound before the user interacts with it. The audio
 *   context is created on the first key or pointer press, and a cue requested
 *   in the very next frame plays. A cue requested before that, or before its
 *   file arrived, doesn't play: a late sound is worse than none. The first cue
 *   requested before the first interaction is logged once, through Effect's
 *   logger, so a game that opens with a sound learns why it isn't heard.
 * - A cue only plays while the audio is running. While it is suspended, or
 *   still resuming, which takes a moment when the page becomes visible again, a
 *   cue is dropped, as one before the first interaction is: started then, it
 *   would be delayed and play all at once with every other delayed cue.
 * - Music is never late, since it is what should be playing: a track requested
 *   before the first interaction, or before its file arrived, starts as soon as
 *   it can. It loops, or plays once to its end if requested, and a change of
 *   track or volume fades over the requested duration.
 * - A cue or a track without a file, or whose file couldn't be fetched or
 *   decoded, is logged once through Effect's logger, and plays nothing.
 * - While its display, `Driver.Display`, reports the page as hidden, the audio
 *   is suspended, music included, and resumed when the page is visible again:
 *   the frame loop is paused then, and a frozen game should be silent.
 *   `Browser.layer` provides the page's display.
 * - A page without Web Audio plays nothing.
 * - When its scope closes, the audio context is closed, pending file requests
 *   are cancelled, and the page is no longer listened to, so provide it to the
 *   whole program. `Browser.runMain` and `Browser.layer` do, unless given
 *   `sounds: false`.
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
      const shown = yield* Driver.Display;
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

      /** Returns what is played for a name or a clip, if it is available. */
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

      /** Starts a streamed track, silent, with its own volume. */
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

      /** Moves a channel from what it is playing to what it should play. */
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
                decode(new Uint8Array(bytes).buffer).then(
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
            unwatch = shown.onVisibilityChange(() => {
              // What is streamed keeps its own time, and is stopped and
              // started with the audio it plays into.
              if (shown.hidden()) {
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
  );

/**
 * Returns a layer that provides a page's display and input devices to a whole
 * program.
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
 * - Gamepads are read when the app samples, once per tick. Unplugging one
 *   releases all its inputs.
 * - It listens from when it is built until its scope closes, so provide it to
 *   the whole program, not to `App.make` alone; `Browser.runMain` does.
 *   Provided to `App.make` alone, it is released as soon as the app is created,
 *   and the first device read throws and says so.
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
  );

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
 * The parts of a page's audio that are used; the browser's `AudioContext`
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
  createMediaElementSource?(media: any): { connect(to: unknown): unknown };
  /** Stops its clock, and with it every sound, until resumed. */
  suspend?(): Promise<unknown>;
  resume?(): Promise<unknown>;
  close(): Promise<unknown>;
}

/**
 * The parts of a streamed track's player that are used; an `<audio>` element
 * satisfies it.
 *
 * @category Models
 */
export interface MediaLike {
  loop: boolean;
  play: () => Promise<unknown>;
  pause: () => void;
}

/**
 * Makes a streamed track: a `Sound.Clip` that holds only its file's URL. Played
 * on a channel, the page fetches and decodes it progressively, while a file
 * given by URL, and `Browser.sound`, are fetched whole and kept decoded: a long
 * piece of music takes tens of megabytes that way, and a few hundred kilobytes
 * streamed.
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
 * - It isn't an asset and belongs to no bundle: nothing is fetched until it
 *   plays, so there is nothing to load or release, and it doesn't go through
 *   `Assets.Loader`. A test plays `Sound.clip(name)` instead.
 * - It is for a channel's track. Played as a cue, it is logged once through
 *   Effect's logger and not played, since a cue must sound immediately.
 * - It starts, fades and stops like any track, and with `once` plays to its
 *   end. A looping stream may have an audible seam where it loops, so decode a
 *   short piece that must loop seamlessly.
 *
 * @category Constructors
 */
export const stream = (url: string): Sound.Clip =>
  Sound.clip(url, new Streamed(url));

/** One music channel: what it should play, and what it is playing. */
interface Channel {
  wanted:
    | {
        readonly track: Sound.Playable;
        readonly volume: number;
        /** Whether it plays to its end and stops. */
        readonly once: boolean;
      }
    | undefined;
  /** The duration, in seconds, of the most recently requested change. */
  fade: number;
  playing:
    | {
        readonly track: Sound.Playable;
        readonly gain: ReturnType<AudioLike["createGain"]>;
        /** Sets whether it loops, or plays to its end and stops. */
        readonly loop: (on: boolean) => void;
        /** Stops it `fade` seconds after `now`, when it falls silent. */
        readonly end: (now: number, fade: number) => void;
      }
    | undefined;
}

/**
 * Makes a sound asset, decoded and ready to play: a `Sound.Clip`, in a bundle
 * with the rest of a level's assets, playable wherever a cue's or a track's
 * name is.
 *
 *   const Forest = Assets.bundle("game/Forest", {
 *     chirp: Browser.sound("/chirp.wav"),
 *     theme: Browser.sound("/forest.ogg"),
 *   })
 *
 * - It is decoded whole into memory as it arrives, so a long track takes memory
 *   in proportion to its length.
 * - Once its bundle is released, the bundle no longer plays it; whatever is
 *   still sounding plays to its end, or until its channel changes, and is freed
 *   afterwards.
 *
 * @category Constructors
 */
export const sound = (url: string): Assets.Asset<Sound.Clip> =>
  Assets.make(url, (data, at) =>
    Effect.tryPromise({
      // A copy: decoding keeps the buffer it is given.
      try: async () =>
        Sound.clip(at, await decodeOffline(new Uint8Array(data).buffer)),
      catch: (error) =>
        new Assets.AssetFailed({
          url: at,
          message: `It could not be made a sound: ${describe(error)}`,
        }),
    })
  );

// --- pictures --------------------------------------------------------------------

/**
 * Makes an image asset, decoded and ready to draw: an `ImageBitmap`, closed
 * when the scope it was loaded in closes.
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
          createImageBitmap(new Blob([new Uint8Array(data)])),
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
 * Runs a game in a page. It wraps the game in the platform's `runMain`
 * (`BrowserRuntime.runMain`), with `Browser.layer(options)` provided to the
 * whole program.
 *
 *   Browser.runMain(App.run({ plugins: [Game] }, { hz: 60 }), { target: canvas })
 *
 * - The game must have no remaining requirements: provide your game's own
 *   services to it first, and a missing one is a compile error here.
 * - A failure is reported through Effect's logger.
 * - When the page is closed for good (`pagehide`, and not entering the
 *   back/forward cache), the game is interrupted: the frame loop stops, the
 *   app's scope closes, and the page is no longer listened to.
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
