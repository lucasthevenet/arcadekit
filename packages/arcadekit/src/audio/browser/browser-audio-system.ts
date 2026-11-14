/**
 * The browser's audio system: an `AudioMixer` over Web Audio, unlocked on the player's first
 * gesture that lets audio start, and silent while the tab is hidden.
 *
 * The browser lets audio start only during a gesture's own dispatch, so the listener that makes
 * the AudioContext and resumes it is plain, as one that writes what a frame reads is;
 * adding and removing it is the layer's. Decoding and closing the context are Effect. It is in an
 * entry of its own, since Web Audio is a browser's and the root entry is checked with no DOM types.
 *
 * @since 0.7.0
 */
import { Effect, Layer } from "effect";
import type { Scope } from "effect";
import { constVoid } from "effect/Function";

import { AudioMixer, AudioSystem } from "../index";

/**
 * The events that may be the user's first gesture. Not all of them let audio start (a touch's
 * pointerdown, an Escape keydown), so the page listens until one has.
 */
const GESTURES = ["pointerdown", "keydown", "touchend"] as const;

/** A gain of the Web Audio output, with the node a voice or another gain connects to. */
interface WebGain extends AudioMixer.Gain {
  readonly node: GainNode;
}

const webGain = (context: AudioContext, node: GainNode): WebGain => ({
  node,
  ramp: (value, seconds) => {
    const now = context.currentTime;
    const { gain } = node;
    gain.cancelScheduledValues(now);
    if (seconds <= 0) {
      // Setting `value` (rather than only scheduling it) makes it what the next ramp reads as
      // its start: a fresh node's `value` is 1 until audio renders, so a fade-in would start loud.
      gain.value = value;
      return;
    }
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(value, now + seconds);
  },
  dispose: () => node.disconnect(),
});

/** An output over an AudioContext. The mixer passes it only the gains it made. */
const webOutput = (context: AudioContext): AudioMixer.Output => ({
  now: () => context.currentTime,
  gain: (into) => {
    const node = context.createGain();
    node.connect(
      into === undefined ? context.destination : (into as WebGain).node
    );
    return webGain(context, node);
  },
  start: (clip, into, { rate, loop }): AudioMixer.Voice => {
    const source = context.createBufferSource();
    // Clips come from `decode` below, so each is an AudioBuffer.
    source.buffer = clip as AudioBuffer;
    source.playbackRate.value = rate;
    source.loop = loop;
    source.connect((into as WebGain).node);
    source.start();
    return {
      stop: (afterSeconds) => {
        try {
          source.stop(context.currentTime + afterSeconds);
        } catch {
          // Already stopped.
        }
      },
    };
  },
});

/**
 * Fetches and decodes one file, with an OfflineAudioContext, which the browser lets a page make
 * before any gesture (an AudioContext made then is suspended, with a console warning). An
 * AudioBuffer from one context plays in any other. Interrupting it aborts the fetch.
 */
const makeDecode = (): AudioMixer.Options["decode"] => {
  let decoder: OfflineAudioContext | null = null;
  return Effect.fnUntraced(function* (file: string) {
    const failure = (cause: unknown) =>
      new AudioSystem.AudioLoadError({
        file,
        message: `The sound ${file} can't be loaded: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      });
    const response = yield* Effect.tryPromise({
      try: (signal) => fetch(file, { signal }),
      catch: failure,
    });
    if (!response.ok) {
      return yield* new AudioSystem.AudioLoadError({
        file,
        message: `The sound ${file} can't be loaded: HTTP ${response.status}`,
      });
    }
    const bytes = yield* Effect.tryPromise({
      try: () => response.arrayBuffer(),
      catch: failure,
    });
    return yield* Effect.tryPromise({
      try: (): Promise<AudioMixer.Clip> => {
        decoder ??= new OfflineAudioContext(1, 1, 44_100);
        return decoder.decodeAudioData(bytes);
      },
      catch: failure,
    });
  });
};

/** Whether this browser has Web Audio. */
const hasWebAudio = (): boolean =>
  typeof AudioContext === "function" &&
  typeof OfflineAudioContext === "function";

/** The mixer over Web Audio, for the life of the scope. */
const webAudio: Effect.Effect<AudioSystem.AudioSystem, never, Scope.Scope> =
  Effect.gen(function* () {
    let context: AudioContext | null = null;
    // Closed last, once the mixer has stopped its voices and the listeners are gone.
    yield* Effect.addFinalizer(() => {
      const closing = context;
      context = null;
      return closing === null
        ? Effect.void
        : Effect.tryPromise(() => closing.close()).pipe(Effect.ignore);
    });
    const mixer = yield* AudioMixer.make({ decode: makeDecode() });

    const unlock = () => {
      // Wait for an event that lets audio start, where the browser says which those are.
      if (navigator.userActivation?.isActive === false) {
        return;
      }
      if (context === null) {
        try {
          context = new AudioContext();
        } catch {
          // No sound for this page.
          removeGestures();
          return;
        }
        AudioMixer.unlock(mixer, webOutput(context));
      }
      const started = context;
      started
        .resume()
        .then(() => started.state === "running" && removeGestures())
        .catch(constVoid);
    };
    const removeGestures = () => {
      for (const type of GESTURES) {
        document.removeEventListener(type, unlock, { capture: true });
      }
    };
    const onVisibility = () => {
      AudioMixer.setHidden(mixer, document.hidden);
      if (context !== null) {
        (document.hidden ? context.suspend() : context.resume()).catch(
          constVoid
        );
      }
    };

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        for (const type of GESTURES) {
          document.addEventListener(type, unlock, { capture: true });
        }
        document.addEventListener("visibilitychange", onVisibility);
        AudioMixer.setHidden(mixer, document.hidden);
      }),
      () =>
        Effect.sync(() => {
          removeGestures();
          document.removeEventListener("visibilitychange", onVisibility);
        })
    );
    return mixer.system;
  });

/**
 * Provides the browser's audio system, for as long as the layer is in use. It makes no
 * AudioContext until the player's first pointer, key or touch gesture that lets audio start, and
 * it is silent while the tab is hidden. In a browser without Web Audio it provides
 * `AudioSystem.silent`.
 *
 * **When to use**
 *
 * Once, in a browser app's resources, under everything that plays: its sound views, through a
 * `Game.Engine`'s `uses`, and its Commands. A test provides `AudioSystem.layerSilent`, or its own
 * audio system with `Layer.succeed`.
 *
 * **Details**
 *
 * A gesture the browser won't start audio for (a touch's `pointerdown`, an Escape `keydown`) is
 * waited past: the layer listens until the context runs. A browser that refuses an AudioContext
 * gives the page no sound, as one without Web Audio does. A sound's file is fetched and decoded on
 * an OfflineAudioContext, so a load can run before the gesture; a response that isn't a success,
 * or a file the browser can't decode, fails the load with an `AudioLoadError`. When the layer's
 * scope closes it stops listening, stops every sound and closes the context.
 *
 * **Example** (The app's audio system)
 *
 * ```ts
 * import { AudioSystem } from "arcadekit/audio";
 * import { BrowserAudioSystem } from "arcadekit/audio/browser";
 * import { Effect } from "effect";
 *
 * const program = Effect.gen(function* () {
 *   const audio = yield* AudioSystem.AudioSystem;
 *   audio.play("click"); // dropped: nothing is loaded, and no gesture has unlocked audio yet
 *   return AudioSystem.isAudioSystem(audio);
 * });
 * Effect.runSync(program.pipe(Effect.provide(BrowserAudioSystem.layer))); // => true
 * ```
 *
 * @category layers
 * @since 0.7.0
 */
export const layer: Layer.Layer<AudioSystem.AudioSystem> = Layer.effect(
  AudioSystem.AudioSystem,
  Effect.suspend(() =>
    hasWebAudio() ? webAudio : Effect.succeed(AudioSystem.silent)
  )
);
