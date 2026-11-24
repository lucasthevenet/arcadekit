import { Effect, Fiber, Layer } from "effect";

import * as Assets from "../Assets";
import * as Driver from "../Driver";
import * as Sound from "../Sound";
import { Streamed, decodeOffline, describe } from "./Media";
import type { AudioLike, MediaLike, Options } from "./Options";

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
        readonly gain: ReturnType<AudioLike["createGain"]>;
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
  files: Readonly<Record<string, string | Sound.Clip>>,
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
  let audio: AudioLike | undefined;
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
  /** Returns what is played for a name or a clip, if it is available. */
  const bufferOf = (sound: Sound.Playable): unknown => {
    if (typeof sound !== "string") {
      return sound.data;
    }
    if (!Object.hasOwn(files, sound)) {
      if (!missing.has(sound)) {
        missing.add(sound);
        fork(
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
      play(cue, volume, rate) {
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
            fork(
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
              held ??= openPage(files, options, loader, display, fork);
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
              play: (cue, volume, rate) => use().play(cue, volume, rate),
              music: (channel, track, volume, fade, once) =>
                use().music(channel, track, volume, fade, once),
            };
          }
        ),
      };
    })
  );
