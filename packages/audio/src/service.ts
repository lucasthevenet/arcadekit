import { Context, Effect, Function, Layer } from "effect";

import type { AudioSystem } from "./system";

/**
 * The app's audio system, as a service. `@gamekit/audio/browser`'s `BrowserAudioLayer` makes
 * the real one; `SilentAudioLayer` is for tests and browsers without Web Audio.
 */
export class Audio extends Context.Service<Audio, AudioSystem>()(
  "@gamekit/audio/Audio"
) {}

/** An audio system that plays nothing. Loading succeeds without fetching. */
export const silentAudio: AudioSystem = {
  play: Function.constVoid,
  setLoop: Function.constVoid,
  playMusic: Function.constVoid,
  setVolume: Function.constVoid,
  setMuted: Function.constVoid,
  setDucked: Function.constVoid,
  load: () => Effect.void,
};

/** Provides `silentAudio`. */
export const SilentAudioLayer: Layer.Layer<Audio> = Layer.succeed(
  Audio,
  silentAudio
);
