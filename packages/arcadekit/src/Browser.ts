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

/** As much of a gamepad as is read: the browser's `Gamepad` is one. */
export interface GamepadLike {
  readonly index: number;
  readonly connected: boolean;
  readonly buttons: ArrayLike<{ readonly pressed: boolean }>;
  readonly axes: ArrayLike<number>;
}

/** As much of an element as the pointer is measured against. */
export interface PointerTarget extends EventTarget {
  readonly getBoundingClientRect?: () => {
    readonly left: number;
    readonly top: number;
  };
}

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
   * The files of the sounds the page has for as long as it lasts, by the
   * name a cue or a track is played by, as `Browser.layerSound` takes
   * them. Left out, the page still plays the sounds a level's bundle
   * holds, `Browser.sound`. `false` is a page with no sound at all: no
   * audio is made, and the game is told that nothing is heard.
   */
  readonly sounds?: Readonly<Record<string, string>> | false;
  /** How loud everything is played: 1, as it asks, when left out. */
  readonly volume?: number;
  /** Makes the page's audio. `new AudioContext()`, when left out. */
  readonly audio?: () => AudioLike;
  /**
   * Makes a sound of a file's bytes. `decodeAudioData`, of a context that
   * plays nothing and so needs no touch, when left out.
   */
  readonly decode?: (data: ArrayBuffer) => Promise<unknown>;
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

/** As much of a page's audio as is used: the browser's `AudioContext` is one. */
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
  /** Stops its clock, and with it everything that sounds, until it is resumed. */
  suspend?(): Promise<unknown>;
  resume?(): Promise<unknown>;
  close(): Promise<unknown>;
}

// Decoding needs no touch, only playing does: a context that plays nothing
// decodes a file as soon as it is there.
const decodeOffline = (data: ArrayBuffer): Promise<unknown> =>
  new OfflineAudioContext(1, 1, 44_100).decodeAudioData(data);

/** One channel of music: what it is to play, and what it is playing. */
interface Channel {
  wanted:
    | { readonly track: Sound.Playable; readonly volume: number }
    | undefined;
  /** How many seconds the change that was last asked for takes. */
  fade: number;
  playing:
    | {
        readonly track: Sound.Playable;
        readonly source: ReturnType<AudioLike["createBufferSource"]>;
        readonly gain: ReturnType<AudioLike["createGain"]>;
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
 *   worse than none.
 * - Music is not late, it is what should be playing: a track that was
 *   asked for before the first touch, or before its file was there, starts
 *   when it can. It plays over and over, and a change of track or of
 *   volume is a fade of as long as was asked.
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
 */
export const layerSound = (
  files: Readonly<Record<string, string>> = {},
  options: Pick<Options, "audio" | "decode" | "volume" | "window"> = {}
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
      const buffers = new Map<string, unknown>();
      const missing = new Set<string>();
      const channels = new Map<string, Channel>();
      const display = yield* Driver.Display;
      let audio: AudioLike | undefined;
      let unwatch: (() => void) | undefined;
      let closed = false;
      const failed = (cue: string, error: unknown): void => {
        report(
          Effect.logWarning(
            `The sound "${cue}" (${files[cue]}) will not be played: ${describe(error)}`
          )
        );
      };
      /** What is played for a name or a clip, if it is there to play. */
      const bufferOf = (sound: Sound.Playable): unknown => {
        if (typeof sound !== "string") {
          return sound.data;
        }
        if (!Object.hasOwn(files, sound) && !missing.has(sound)) {
          missing.add(sound);
          report(
            Effect.logWarning(
              `The sound "${sound}" was played and has no file. The page's sounds are: ${Object.keys(files).join(", ") || "none"}.`
            )
          );
        }
        return buffers.get(sound);
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
          playing.source.stop(now + fade);
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
          const source = audio.createBufferSource();
          source.buffer = buffer;
          source.loop = true;
          const gain = audio.createGain();
          gain.gain.setValueAtTime(0, now);
          gain.gain.linearRampToValueAtTime(wanted.volume * master, now + fade);
          source.connect(gain);
          gain.connect(audio.destination);
          source.start();
          channel.playing = { track: wanted.track, source, gain };
        } else {
          // The same track, louder or softer.
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
          Object.entries(files),
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
              if (display.hidden()) {
                void audio?.suspend?.();
              } else {
                void audio?.resume?.();
              }
            });
          }
          // What should have been playing all along starts now.
          settleAll();
        } else if (audio.state === "suspended") {
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
        music(name, track, volume, fade) {
          let channel = channels.get(name);
          if (channel === undefined) {
            channel = { wanted: undefined, fade, playing: undefined };
            channels.set(name, channel);
          }
          channel.wanted = track === undefined ? undefined : { track, volume };
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
