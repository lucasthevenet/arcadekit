/**
 * Audio systems: what an app and its sound views play sound through, and the key of the service
 * an app provides.
 *
 * An audio system is a value with its calls as fields, as Effect's `KeyValueStore` is, since a
 * sound view calls them on whatever system it was given: the browser's, which
 * `arcadekit/audio/browser` makes over an `AudioMixer`, the silent one, or a test's. Every call but
 * `load` is plain, and none throws: a sound view plays inside the frame that draws (ADR-0024), and
 * whatever can't play is dropped. The module also has what the calls take: a sound list, the
 * Schema of a sound id, and the error a load fails with.
 *
 * @since 0.7.0
 */
import {
  Context,
  Effect,
  Inspectable,
  Layer,
  Pipeable,
  Predicate,
  Schema,
} from "effect";
import type { Cause, Types } from "effect";
import { constVoid, dual } from "effect/Function";

import type * as AudioSettings from "./audio-settings";

const TypeId = "~arcadekit/audio/AudioSystem";

/**
 * A bus a sound plays through. A sound plays through `sfx` or `music`, and both feed `master`.
 *
 * **When to use**
 *
 * To say which bus a volume is for, in `setVolume`.
 *
 * **Example** (Turning the music down)
 *
 * ```ts
 * import { AudioSystem } from "arcadekit/audio";
 *
 * const set: [AudioSystem.Bus, number][] = [];
 * const audio = AudioSystem.make({
 *   setVolume: (bus, volume) => {
 *     set.push([bus, volume]);
 *   },
 * });
 * audio.setVolume("music", 0.3);
 * set; // => [["music", 0.3]]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type Bus = "master" | "sfx" | "music";

/**
 * One sound of an app's sound list: its file and how it plays.
 *
 * **When to use**
 *
 * To write a sound list, or a helper that makes its entries.
 *
 * **Details**
 *
 * A play past the voice cap, or sooner after the last start than the minimum gap, is dropped, so a
 * moment a game counts hundreds of times a second doesn't play as a burst (ADR-0014).
 *
 * **Example** (A shot that may play four at once)
 *
 * ```ts
 * import { AudioSystem } from "arcadekit/audio";
 *
 * const shot: AudioSystem.Sound = {
 *   file: "/sounds/shot.wav",
 *   pitchJitter: 0.08,
 *   maxVoices: 4,
 *   minGapMs: 60,
 * };
 * shot.bus ?? "sfx"; // => "sfx"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Sound {
  /** The file's URL, such as `/sounds/shot.wav`. */
  readonly file: string;
  /** The bus it plays through. Defaults to `sfx`. */
  readonly bus?: "sfx" | "music";
  /** Its base volume, 0 to 1. Defaults to 1. */
  readonly volume?: number;
  /** How far each play's speed (and so pitch) may stray from 1, such as 0.05 for ±5%. Defaults to 0. */
  readonly pitchJitter?: number;
  /** How far below its volume each play may be, such as 0.2 for up to 20% quieter. Defaults to 0. */
  readonly volumeJitter?: number;
  /** How many plays of it may sound at once. A play past the cap is dropped. Defaults to 6. */
  readonly maxVoices?: number;
  /** The least time between two starts of it, in ms. A play sooner is dropped. Defaults to 40 for sfx, 0 for music. */
  readonly minGapMs?: number;
}

/**
 * An app's sounds by id: what it loads, and what a sound id names.
 *
 * **When to use**
 *
 * Once per app, for every sound it ships, given to `load` at startup.
 *
 * **Details**
 *
 * Write it `satisfies AudioSystem.SoundList`, not annotated, to keep its keys: an app can then
 * check a cue table's sounds against them (`satisfies Record<string, keyof typeof SOUNDS>`).
 *
 * **Example** (A sound list that keeps its keys)
 *
 * ```ts
 * import { AudioSystem } from "arcadekit/audio";
 *
 * const SOUNDS = {
 *   click: { file: "/sounds/click.wav" },
 *   music: { file: "/sounds/music.wav", bus: "music" },
 * } satisfies AudioSystem.SoundList;
 * Object.keys(SOUNDS); // => ["click", "music"]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type SoundList = Readonly<Record<string, Sound>>;

/**
 * A sound id, as a Schema: the name of one sound in the app's sound list, as `play` takes it, and
 * never empty.
 *
 * **When to use**
 *
 * To declare a cue of a `CueTable`: what the app gives for it is a sound id. A cue an app may
 * leave silent is `Schema.NullOr(AudioSystem.SoundId)`.
 *
 * **Example** (Checking a sound id)
 *
 * ```ts
 * import { AudioSystem } from "arcadekit/audio";
 * import { Schema } from "effect";
 *
 * const isSoundId = Schema.is(AudioSystem.SoundId);
 * isSoundId("click"); // => true
 * isSoundId(""); // => false
 * ```
 *
 * @category schemas
 * @since 0.7.0
 */
export const SoundId: Schema.NonEmptyString = Schema.NonEmptyString;

/** The class `Schema.TaggedError` makes for `AudioLoadError`, written out for isolatedDeclarations. */
type AudioLoadErrorClass = Schema.Class<
  AudioLoadError,
  Schema.TaggedStruct<
    "AudioLoadError",
    {
      readonly file: Schema.String;
      readonly message: Schema.String;
      readonly cause: Schema.optional<Schema.Defect>;
    }
  >,
  Cause.YieldableError
>;

// Named so the type files can be made one file at a time (isolatedDeclarations).
const AudioLoadErrorBase: AudioLoadErrorClass =
  // oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError makes a class; it is not an error being thrown.
  Schema.TaggedError<AudioLoadError>()("AudioLoadError", {
    file: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  });

/**
 * A sound file that couldn't be fetched or decoded: what `load` fails with.
 *
 * **When to use**
 *
 * Catch it by its tag where an app loads its sounds, `Effect.catchTag("AudioLoadError", ...)`, and
 * play on without the sound: a load adds every sound whose file did load.
 *
 * **Details**
 *
 * `file` is the file's URL and `message` says what went wrong, for a log. `cause` is what was
 * thrown, if anything was: a fetch that failed, or a file the browser couldn't decode.
 *
 * **Example** (Logging a sound that can't be loaded)
 *
 * ```ts
 * import { AudioSystem } from "arcadekit/audio";
 * import { Effect } from "effect";
 *
 * const audio = AudioSystem.make({
 *   load: () =>
 *     Effect.fail(
 *       new AudioSystem.AudioLoadError({ file: "/sounds/lap.wav", message: "HTTP 404" })
 *     ),
 * });
 * const loading = audio
 *   .load({ lap: { file: "/sounds/lap.wav" } })
 *   .pipe(Effect.catchTag("AudioLoadError", (error) => Effect.succeed(error.file)));
 * Effect.runSync(loading); // => "/sounds/lap.wav"
 * ```
 *
 * @category errors
 * @since 0.7.0
 */
export class AudioLoadError extends AudioLoadErrorBase {}

/**
 * What an app and its sound views play sound through. Every call but `load` is plain and
 * synchronous, so a sound view plays during its `render`, and none throws: an unknown or not yet
 * loaded id, or a play before the player's first gesture unlocks audio, is dropped.
 *
 * **When to use**
 *
 * Name it to type what a sound view is given, and yield its key, `AudioSystem.AudioSystem`, to
 * reach the app's: a `Game.Engine` names it in `uses`, and a Command yields it.
 *
 * **Details**
 *
 * Its calls are fields, as a service's are, so each system has its own: `BrowserAudioSystem.layer`
 * gives the browser's, `silent` plays nothing, and `make` gives a test's. A system prints as
 * `{ _id: "AudioSystem" }`.
 *
 * **Example** (A sound view's play, piped or called)
 *
 * ```ts
 * import { AudioSystem } from "arcadekit/audio";
 *
 * const played: string[] = [];
 * const audio: AudioSystem.AudioSystem = AudioSystem.make({
 *   play: (id) => {
 *     played.push(id);
 *   },
 * });
 * audio.play("lap");
 * audio.play("bump", { volume: 0.5 });
 * played; // => ["lap", "bump"]
 * audio.pipe(AudioSystem.isAudioSystem); // => true
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface AudioSystem
  extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  /** Plays a one-shot sound once. `volume` (0 to 1) scales its own volume, such as quieter for a teammate's hurt. */
  readonly play: (id: string, options?: { readonly volume?: number }) => void;
  /**
   * Keeps a looping sound playing at `volume` (0 to 1, times its own volume). Call it every frame
   * with the volume you want: the same volume again changes nothing, a new one glides to it, and 0
   * fades the loop out and stops it.
   */
  readonly setLoop: (id: string, volume: number) => void;
  /** Crossfades to music track `id` (looping), or fades the music out with null. The track already playing is a no-op. */
  readonly playMusic: (
    id: string | null,
    options?: { readonly fadeSeconds?: number }
  ) => void;
  /** Sets a bus's volume, 0 to 1. */
  readonly setVolume: (bus: Bus, volume: number) => void;
  /** Silences everything, or brings it back. */
  readonly setMuted: (muted: boolean) => void;
  /** Lowers the music, such as while the game is paused. */
  readonly setDucked: (ducked: boolean) => void;
  /**
   * Fetches and decodes sounds and adds them by id. A file shared by several ids, or asked for by
   * two loads at once, is loaded once, and a file loaded before isn't loaded again. Every sound
   * whose file loads is added; if any file fails, it then fails with the first error. A file that
   * failed, or whose every load was interrupted, is tried again by the next load that asks for it.
   */
  readonly load: (sounds: SoundList) => Effect.Effect<void, AudioLoadError>;
}

/**
 * The key of the app's audio system, as a service: `yield* AudioSystem.AudioSystem` gives it.
 *
 * **When to use**
 *
 * To reach the app's audio system from an Effect, such as a Command that plays a click, and to
 * name it in a `Game.Engine`'s `uses`, so its `view` is handed it on each attach. An app provides
 * it once, with `BrowserAudioSystem.layer`; a test with `layerSilent`, or `Layer.succeed` over
 * `make`.
 *
 * **Details**
 *
 * It is keyed `arcadekit/audio/AudioSystem`, and its type is the audio system's, as Effect's
 * `KeyValueStore` is a store's: `Layer.Layer<AudioSystem.AudioSystem>`.
 *
 * **Example** (A Command's click)
 *
 * ```ts
 * import { AudioSystem } from "arcadekit/audio";
 * import { Effect, Layer } from "effect";
 *
 * const played: string[] = [];
 * const recording = Layer.succeed(
 *   AudioSystem.AudioSystem,
 *   AudioSystem.make({
 *     play: (id) => {
 *       played.push(id);
 *     },
 *   })
 * );
 * const click = Effect.gen(function* () {
 *   (yield* AudioSystem.AudioSystem).play("click");
 * });
 * Effect.runSync(click.pipe(Effect.provide(recording)));
 * played; // => ["click"]
 * ```
 *
 * @category services
 * @since 0.7.0
 */
export const AudioSystem: Context.Service<AudioSystem, AudioSystem> =
  Context.Service<AudioSystem>("arcadekit/audio/AudioSystem");

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON() {
    return { _id: "AudioSystem" };
  },
};

/**
 * Checks whether a value is an audio system.
 *
 * **When to use**
 *
 * Narrow an unknown value before playing through it, as a debugging tool that lists an app's
 * services does.
 *
 * **Details**
 *
 * An audio system comes from `make`, `silent` or an `AudioMixer`'s `system`. An object with a
 * `play` of its own is none.
 *
 * **Example** (Recognising an audio system)
 *
 * ```ts
 * import { AudioSystem } from "arcadekit/audio";
 *
 * AudioSystem.isAudioSystem(AudioSystem.silent); // => true
 * AudioSystem.isAudioSystem({ play: () => {} }); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isAudioSystem = (value: unknown): value is AudioSystem =>
  Predicate.hasProperty(value, TypeId);

const loadNothing = (): Effect.Effect<void, AudioLoadError> => Effect.void;

/**
 * Makes an audio system from the calls it is given. Each call it isn't given does nothing, and a
 * `load` it isn't given succeeds without fetching.
 *
 * **When to use**
 *
 * In a test of a sound view or of an app's Commands, to give them an audio system that records
 * what it is asked to do. An app's own comes from `BrowserAudioSystem.layer`, and a mixer's from
 * its `system`.
 *
 * **Details**
 *
 * `make` calls none of them: each call of the system calls what it was given. A trace shows each
 * `load` as `AudioSystem.load`.
 *
 * **Example** (An audio system that records its loops)
 *
 * ```ts
 * import { AudioSystem } from "arcadekit/audio";
 *
 * const loops: [string, number][] = [];
 * const audio = AudioSystem.make({
 *   setLoop: (id, volume) => {
 *     loops.push([id, volume]);
 *   },
 * });
 * audio.setLoop("engine", 0.6);
 * audio.play("lap");
 * loops; // => [["engine", 0.6]]
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = (
  calls: Partial<
    Pick<
      AudioSystem,
      | "play"
      | "setLoop"
      | "playMusic"
      | "setVolume"
      | "setMuted"
      | "setDucked"
      | "load"
    >
  >
): AudioSystem => {
  const self = Object.create(Proto) as Types.Mutable<AudioSystem>;
  const load = calls.load ?? loadNothing;
  self.play = calls.play ?? constVoid;
  self.setLoop = calls.setLoop ?? constVoid;
  self.playMusic = calls.playMusic ?? constVoid;
  self.setVolume = calls.setVolume ?? constVoid;
  self.setMuted = calls.setMuted ?? constVoid;
  self.setDucked = calls.setDucked ?? constVoid;
  self.load = Effect.fn("AudioSystem.load")(function* (sounds: SoundList) {
    yield* load(sounds);
  });
  return self;
};

/**
 * The audio system that plays nothing: every call does nothing, and `load` succeeds without
 * fetching.
 *
 * **When to use**
 *
 * Where a game needs an audio system and nothing should be heard. `BrowserAudioSystem.layer` gives
 * it in a browser without Web Audio, and `layerSilent` provides it.
 *
 * **Example** (Loading into the silent system)
 *
 * ```ts
 * import { AudioSystem } from "arcadekit/audio";
 * import { Effect } from "effect";
 *
 * AudioSystem.silent.play("lap");
 * Effect.runSync(AudioSystem.silent.load({ lap: { file: "/sounds/lap.wav" } })); // => undefined
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export const silent: AudioSystem = make({});

/**
 * Provides the silent audio system.
 *
 * **When to use**
 *
 * In a test of an engine or an app that plays sound but checks something else: its sprites, its
 * saves, its co-op.
 *
 * **Example** (A test's engine resources)
 *
 * ```ts
 * import { AudioSystem } from "arcadekit/audio";
 * import { Effect } from "effect";
 *
 * const program = Effect.gen(function* () {
 *   return yield* AudioSystem.AudioSystem;
 * });
 * const audio = Effect.runSync(program.pipe(Effect.provide(AudioSystem.layerSilent)));
 * audio === AudioSystem.silent; // => true
 * ```
 *
 * @category layers
 * @since 0.7.0
 */
export const layerSilent: Layer.Layer<AudioSystem> = Layer.succeed(
  AudioSystem,
  silent
);

/**
 * Sets an audio system's bus volumes and mute from the player's settings.
 *
 * **When to use**
 *
 * When an app reads its stored audio settings at startup, and each time the player changes them.
 *
 * **Details**
 *
 * It calls `setVolume` for `master`, `sfx` and `music`, then `setMuted`, so each glides there as
 * those calls do.
 *
 * **Example** (Applying the player's settings, called or piped)
 *
 * ```ts
 * import { AudioSettings, AudioSystem } from "arcadekit/audio";
 *
 * const calls: unknown[] = [];
 * const audio = AudioSystem.make({
 *   setVolume: (bus, volume) => {
 *     calls.push([bus, volume]);
 *   },
 *   setMuted: (muted) => {
 *     calls.push(muted);
 *   },
 * });
 * AudioSystem.applySettings(audio, AudioSettings.defaults);
 * calls; // => [["master", 0.8], ["sfx", 0.8], ["music", 0.6], false]
 * audio.pipe(AudioSystem.applySettings({ ...AudioSettings.defaults, muted: true }));
 * calls.at(-1); // => true
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const applySettings: {
  (settings: AudioSettings.AudioSettings): (self: AudioSystem) => void;
  (self: AudioSystem, settings: AudioSettings.AudioSettings): void;
} = dual(
  2,
  (self: AudioSystem, settings: AudioSettings.AudioSettings): void => {
    self.setVolume("master", settings.master);
    self.setVolume("sfx", settings.sfx);
    self.setVolume("music", settings.music);
    self.setMuted(settings.muted);
  }
);
