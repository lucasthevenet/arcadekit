import { Effect, Fiber, Layer } from "effect";

import * as Assets from "../../Assets.ts";
import * as Driver from "../../Driver.ts";
import { Entry } from "../../internal/sheet.ts";
import * as Sound from "../../Sound.ts";
import type { ContextLike, MediaLike } from "../Audio.ts";
import type { Options } from "../Browser.ts";
import { decodeOffline, describe } from "./decode.ts";

/**
 * What a streamed clip holds: only its URL.
 *
 * @internal
 */
export class Streamed {
  constructor(readonly url: string) {}
}

/**
 * Makes a streamed track: `Audio.stream`.
 *
 * @internal
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
        readonly gain: ReturnType<ContextLike["createGain"]>;
        /** Sets whether it loops, or plays to its end and stops. */
        readonly loop: (on: boolean) => void;
        /** Stops it `fade` seconds after `now`, when it falls silent. */
        readonly end: (now: number, fade: number) => void;
      }
    | undefined;
}

/** The page's audio, while some app holds it. */
interface Held {
  readonly speaker: Sound.Speaker;
  /** Closes the audio, stops listening, and gives up what is being fetched. */
  readonly close: Effect.Effect<void>;
  /** How many have it open. */
  holders: number;
}

/** One holder's hold on the page's audio, which it lets go of once. */
interface Hold {
  readonly page: Held;
  open: boolean;
}

/**
 * Starts the page's audio: fetches its files, and makes its audio context at
 * the first touch.
 */
const openPage = (
  sheets: readonly Sound.Sheet[],
  options: Pick<Options, "audio" | "decode" | "media" | "volume" | "window">,
  loader: Assets.LoaderShape,
  display: Driver.DisplayShape,
  fork: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>
): Held => {
  const page: EventTarget = options.window ?? globalThis;
  const make =
    options.audio ??
    (typeof AudioContext === "undefined"
      ? undefined
      : (): ContextLike => new AudioContext());
  const master = options.volume ?? 1;
  const decode = options.decode ?? decodeOffline;
  const media = options.media ?? audioElement;
  // What is being streamed now, to be stopped with the page's audio
  // and started with it, and what waits to stop one.
  const streaming = new Set<MediaLike>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  // The sounds of the sheets it was given that are files, by the clip's
  // entry, and each one's decoded buffer once it is here.
  const files = new Map<
    Entry,
    { readonly cue: string; readonly url: string }
  >();
  for (const sheet of sheets) {
    for (const clip of Object.values(sheet)) {
      const { data } = clip;
      if (data instanceof Entry && data.url !== undefined) {
        files.set(data, { cue: clip.name, url: data.url });
      }
    }
  }
  const buffers = new Map<Entry, unknown>();
  const missing = new Set<string>();
  const channels = new Map<string, Channel>();
  let audio: ContextLike | undefined;
  let unwatch: (() => void) | undefined;
  let closed = false;
  // Whether it was said that a cue came before the first touch.
  let early = false;
  const failed = (cue: string, url: string, error: unknown): void => {
    fork(
      Effect.logWarning(
        `The sound "${cue}" (${url}) will not be played: ${describe(error)}`
      )
    );
  };
  /** Returns what is played for a clip, if it is available. */
  const bufferOf = (sound: Sound.Playable): unknown => {
    const { data } = sound;
    if (!(data instanceof Entry)) {
      return data;
    }
    // A sheet's sound that is another clip plays what that clip does.
    if (data.url === undefined) {
      return data.data;
    }
    if (!files.has(data)) {
      const said = `${data.sheet}.${sound.name}`;
      if (!missing.has(said)) {
        missing.add(said);
        fork(
          Effect.logWarning(
            `The sound "${sound.name}" of the sheet "${data.sheet}" was played, and the page was not given its sheet, so it has not its file. Give the sheet in sounds, as Browser.runMain(game, { sounds: [Sheet] }) does. The page's sheets are: ${Array.from(new Set(Array.from(files.keys(), (entry) => `"${entry.sheet}"`))).join(", ") || "none"}.`
          )
        );
      }
      return undefined;
    }
    return buffers.get(data);
  };
  /** Starts a streamed track, silent, with its own volume. */
  const startStream = (
    context: ContextLike,
    streamed: Streamed,
    once: boolean,
    gain: ReturnType<ContextLike["createGain"]>
  ): Pick<NonNullable<Channel["playing"]>, "end" | "loop"> | undefined => {
    if (context.createMediaElementSource === undefined) {
      if (!missing.has(streamed.url)) {
        missing.add(streamed.url);
        fork(
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
        fork(
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
  // Every file at once, for as long as the audio is held: a request
  // that is still on its way when it is closed is given up.
  const fetching = fork(
    Effect.forEach(
      files,
      ([entry, { cue, url }]) =>
        Effect.match(loader.bytes(url), {
          onSuccess: (bytes) => {
            // A copy: decoding keeps the buffer it is given.
            decode(bytes.slice().buffer).then(
              (buffer) => {
                if (!closed) {
                  buffers.set(entry, buffer);
                  // A channel may have been waiting for it.
                  settleAll();
                }
              },
              (error: unknown) => failed(cue, url, error)
            );
          },
          onFailure: (error) => failed(cue, url, error.message),
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

  return {
    holders: 0,
    speaker: {
      play(cue, { rate, volume }) {
        const buffer = bufferOf(cue);
        // Before the first touch, or before the file is here.
        if (audio === undefined || buffer === undefined) {
          // Before the first touch, on a page that could play it after:
          // said once, since nothing else tells why a game that opens
          // with a sound is not heard.
          if (audio === undefined && make !== undefined && !early) {
            early = true;
            fork(
              Effect.logInfo(
                `The cue "${cue.name}" was asked for before the page was touched, and is not played: a browser lets a page make no sound until its user has pressed a key or a button, and a cue that came late would be worse than none. A track asked for then starts at the first touch. This is said once.`
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
            fork(
              Effect.logWarning(
                `The sound "${buffer.url}" is streamed, which is for a channel's track: as a cue it is not played. A cue is a file given by its URL, or Audio.sound.`
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
      music(name, track, { fade, once, volume }) {
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
    },
    close: Effect.andThen(
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
      }),
      Fiber.interrupt(fetching)
    ),
  };
};

/**
 * The page's sound with Web Audio: `Audio.layerSound`.
 *
 * @internal
 */
export const layerSound = (
  sheets: readonly Sound.Sheet[],
  options: Pick<Options, "audio" | "decode" | "media" | "volume" | "window">
): Layer.Layer<never> =>
  Layer.effect(
    Sound.Output,
    Effect.gen(function* () {
      const loader = yield* Assets.Loader;
      const display = yield* Driver.Display;
      const fork = Effect.runForkWith(yield* Effect.context<never>());
      let held: Held | undefined;
      return {
        open: Effect.map(
          Effect.acquireRelease(
            Effect.sync((): Hold => {
              held ??= openPage(sheets, options, loader, display, fork);
              held.holders += 1;
              return { page: held, open: true };
            }),
            (hold) =>
              Effect.suspend(() => {
                hold.open = false;
                const { page } = hold;
                page.holders -= 1;
                if (page.holders > 0) {
                  return Effect.void;
                }
                held = undefined;
                return page.close;
              })
          ),
          (hold): Sound.Speaker => {
            const use = (): Sound.Speaker => {
              if (!hold.open) {
                throw new Error(
                  "The page's sound was played after it was let go: the app that opened it was closed, or the scope Sound.open ran in had ended. Nothing would be heard: play it through an app that is open."
                );
              }
              return hold.page.speaker;
            };
            return {
              play: (cue, options) => use().play(cue, options),
              music: (channel, track, options) =>
                use().music(channel, track, options),
            };
          }
        ),
      };
    })
  );
