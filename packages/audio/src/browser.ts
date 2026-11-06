import { Effect, Function, Layer } from "effect";
import type { Scope } from "effect";

import { Audio, silentAudio } from "./service";
import { AudioLoadError, makeAudioMixer } from "./system";
import type {
  AudioClip,
  AudioGain,
  AudioMixer,
  AudioOutput,
  AudioSystem,
  AudioVoice,
} from "./system";

// The Web Audio backend. Kept out of the root entry so the mixer can be checked and tested
// without DOM types.

/**
 * The events that may be the user's first gesture. Not all of them let audio start (a touch's
 * pointerdown, an Escape keydown), so the page listens until one has.
 */
const GESTURES = ["pointerdown", "keydown", "touchend"] as const;

class WebGain implements AudioGain {
  readonly context: AudioContext;
  readonly node: GainNode;

  constructor(context: AudioContext, node: GainNode) {
    this.context = context;
    this.node = node;
  }

  ramp(value: number, seconds: number): void {
    const now = this.context.currentTime;
    const { gain } = this.node;
    gain.cancelScheduledValues(now);
    if (seconds <= 0) {
      // Setting `value` (rather than only scheduling it) makes it what the next ramp reads as
      // its start: a fresh node's `value` is 1 until audio renders, so a fade-in would start loud.
      gain.value = value;
      return;
    }
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(value, now + seconds);
  }

  dispose(): void {
    this.node.disconnect();
  }
}

/** An `AudioOutput` over an AudioContext. */
const webOutput = (context: AudioContext): AudioOutput => ({
  now: () => context.currentTime,
  gain: (into) => {
    const node = context.createGain();
    node.connect(into instanceof WebGain ? into.node : context.destination);
    return new WebGain(context, node);
  },
  start: (clip, into, { rate, loop }): AudioVoice => {
    const source = context.createBufferSource();
    // Clips come from `decodeAudioData` below, so each is an AudioBuffer.
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
 * Decodes with an OfflineAudioContext, which the browser lets a page make before any gesture
 * (an AudioContext made then is suspended, with a console warning). An AudioBuffer from one
 * context plays in any other.
 */
const makeDecoder = () => {
  let decoder: OfflineAudioContext | null = null;
  return (file: string): Effect.Effect<AudioClip, AudioLoadError> =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(file, { signal });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const bytes = await response.arrayBuffer();
        decoder ??= new OfflineAudioContext(1, 1, 44_100);
        return await decoder.decodeAudioData(bytes);
      },
      catch: (cause) =>
        new AudioLoadError({
          file,
          message: `The sound ${file} can't be loaded: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        }),
    });
};

/** Whether this browser has Web Audio. */
const hasWebAudio = (): boolean =>
  typeof AudioContext === "function" &&
  typeof OfflineAudioContext === "function";

/**
 * Makes the browser's audio system. It stays silent until the first pointer, key or touch
 * gesture on the page that lets audio start, then makes its AudioContext; it keeps listening
 * until the context runs. It is silent while the tab is hidden.
 * Closing its scope removes its listeners, stops its sounds and closes the context.
 */
export const makeBrowserAudio: Effect.Effect<AudioMixer, never, Scope.Scope> =
  Effect.gen(function* () {
    const audio = yield* makeAudioMixer({
      decode: makeDecoder(),
      random: Math.random,
    });
    let context: AudioContext | null = null;

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
        audio.unlock(webOutput(context));
      }
      const started = context;
      started
        .resume()
        .then(() => started.state === "running" && removeGestures())
        .catch(Function.constVoid);
    };
    const removeGestures = () => {
      for (const type of GESTURES) {
        document.removeEventListener(type, unlock, { capture: true });
      }
    };
    const onVisibility = () => {
      audio.setHidden(document.hidden);
      if (context !== null) {
        (document.hidden ? context.suspend() : context.resume()).catch(
          Function.constVoid
        );
      }
    };

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        for (const type of GESTURES) {
          document.addEventListener(type, unlock, { capture: true });
        }
        document.addEventListener("visibilitychange", onVisibility);
        audio.setHidden(document.hidden);
      }),
      () =>
        Effect.sync(() => {
          removeGestures();
          document.removeEventListener("visibilitychange", onVisibility);
          audio.dispose();
          context?.close().catch(Function.constVoid);
          context = null;
        })
    );
    return audio;
  });

/**
 * Provides `Audio` with the browser's audio system, torn down when the layer's scope closes.
 * Without Web Audio it provides the silent one.
 */
export const BrowserAudioLayer: Layer.Layer<Audio> = Layer.effect(
  Audio,
  Effect.suspend((): Effect.Effect<AudioSystem, never, Scope.Scope> =>
    hasWebAudio() ? makeBrowserAudio : Effect.succeed(silentAudio)
  )
);
