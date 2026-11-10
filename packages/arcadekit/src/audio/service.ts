import { Context, Effect, Function, Layer } from "effect";

import type { AudioSystem } from "./system";

// Named so the type files can be made one file at a time (isolatedDeclarations).
const AudioKey: Context.ServiceClass<
  Audio,
  "arcadekit/audio/Audio",
  AudioSystem
> = Context.Service<Audio, AudioSystem>()("arcadekit/audio/Audio");

/**
 * The app's audio system, as a service. `arcadekit/audio/browser`'s `BrowserAudioLayer` makes
 * the real one; `SilentAudioLayer` is for tests and browsers without Web Audio.
 */
export class Audio extends AudioKey {}

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
