/**
 * Audio mixers: the audio system behind the browser's, with its sounds by id, its buses, voices,
 * loops and music, playing into whatever output its host unlocks it with.
 *
 * The mixer never touches Web Audio itself. It drives an `Output` (`arcadekit/audio/browser` wraps
 * an AudioContext; a test passes a fake) and decodes through the function it is given, so all of
 * its rules (unlock, voice limits, buses, crossfades) run in a plain test. Its play calls are plain,
 * since a sound view makes them inside its frame (ADR-0024), and so are its host's controls, which
 * the browser calls while it dispatches a gesture or a change of the page's visibility. Its loads
 * and its lifecycle are Effect: the scope it is made in stops its voices when it closes.
 *
 * @since 0.7.0
 */
import {
  Cache,
  Duration,
  Effect,
  Exit,
  Inspectable,
  Pipeable,
  Predicate,
  Random,
  Result,
} from "effect";
import type { Scope, Types } from "effect";
import { dual } from "effect/Function";

import * as AudioSystem from "./audio-system";

const TypeId = "~arcadekit/audio/AudioMixer";

/**
 * A decoded sound. Web Audio's `AudioBuffer` is one.
 *
 * **When to use**
 *
 * What an `Options`'s `decode` gives, and what an `Output` starts.
 *
 * **Example** (A test's clip)
 *
 * ```ts
 * import { AudioMixer } from "arcadekit/audio";
 *
 * const clip: AudioMixer.Clip = { duration: 0.5 };
 * clip.duration; // => 0.5
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Clip {
  /** Its length in seconds. */
  readonly duration: number;
}

/**
 * A gain stage of an output: a bus, or one voice's own volume.
 *
 * **When to use**
 *
 * To write an `Output`: its `gain` makes one.
 *
 * **Example** (A gain that keeps its value)
 *
 * ```ts
 * import { AudioMixer } from "arcadekit/audio";
 *
 * let value = 1;
 * const gain: AudioMixer.Gain = {
 *   ramp: (to) => {
 *     value = to;
 *   },
 *   dispose: () => {},
 * };
 * gain.ramp(0.5, 0.05);
 * value; // => 0.5
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Gain {
  /** Moves the gain to `value` over `seconds`, from now (0 sets it at once). */
  readonly ramp: (value: number, seconds: number) => void;
  /** Disconnects it. */
  readonly dispose: () => void;
}

/**
 * One playing clip of an output.
 *
 * **When to use**
 *
 * To write an `Output`: its `start` gives one.
 *
 * **Example** (A voice that remembers when it was stopped)
 *
 * ```ts
 * import { AudioMixer } from "arcadekit/audio";
 *
 * let stopIn: number | null = null;
 * const voice: AudioMixer.Voice = {
 *   stop: (afterSeconds) => {
 *     stopIn = afterSeconds;
 *   },
 * };
 * voice.stop(0.3);
 * stopIn; // => 0.3
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Voice {
  /** Stops it `afterSeconds` from now. */
  readonly stop: (afterSeconds: number) => void;
}

/**
 * Where a mixer's sound goes: a small part of Web Audio. `arcadekit/audio/browser` builds one over
 * an AudioContext on the first gesture.
 *
 * **When to use**
 *
 * To unlock a mixer into something other than the browser's speakers: in a test, an output that
 * records each voice it starts.
 *
 * **Details**
 *
 * Voice limits and fades are timed on `now`. A gain `gain` makes starts at 1. The mixer passes
 * `gain` and `start` only gains this output made.
 *
 * **Example** (An output that records what it starts)
 *
 * ```ts
 * import { AudioMixer } from "arcadekit/audio";
 *
 * const started: number[] = [];
 * const output: AudioMixer.Output = {
 *   now: () => 0,
 *   gain: () => ({ ramp: () => {}, dispose: () => {} }),
 *   start: (clip) => {
 *     started.push(clip.duration);
 *     return { stop: () => {} };
 *   },
 * };
 * output.start({ duration: 2 }, output.gain(), { rate: 1, loop: false });
 * started; // => [2]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Output {
  /** The audio clock, in seconds. Voice limits and fades are timed on it. */
  readonly now: () => number;
  /** A new gain, at 1, feeding `into`, or the speakers when it is omitted. */
  readonly gain: (into?: Gain) => Gain;
  /** Starts `clip` now into `into`, at playback speed `rate`. */
  readonly start: (
    clip: Clip,
    into: Gain,
    options: { readonly rate: number; readonly loop: boolean }
  ) => Voice;
}

/**
 * What a mixer is made from besides its output: how it decodes a file, and how far it ducks the
 * music.
 *
 * **When to use**
 *
 * To make a mixer with `make`: a browser decodes with Web Audio, a test with a function that gives
 * a clip of the length it wants.
 *
 * **Details**
 *
 * The mixer asks `decode` for each file once, and again only after that fails or after every load
 * waiting on it was interrupted. Its jitter comes from Effect's `Random`, read once when it is made.
 *
 * **Example** (A test's decode)
 *
 * ```ts
 * import { AudioMixer } from "arcadekit/audio";
 * import { Effect } from "effect";
 *
 * const options: AudioMixer.Options = {
 *   decode: (file) => Effect.succeed({ duration: file.endsWith("-loop.wav") ? 10 : 0.5 }),
 *   duckedMusic: 0.5,
 * };
 * Effect.runSync(options.decode("engine-loop.wav")); // => { duration: 10 }
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Options {
  /** Fetches and decodes one file. */
  readonly decode: (
    file: string
  ) => Effect.Effect<Clip, AudioSystem.AudioLoadError>;
  /** How loud the music is while ducked, as a share of its volume. Defaults to 0.35. */
  readonly duckedMusic?: number;
}

/**
 * The audio system behind the browser's: sounds by id, the three buses, the voices of each sound,
 * loops and music, playing into the output its host unlocks it with. It plays nothing until then.
 *
 * **When to use**
 *
 * Make one where a host owns the output: `arcadekit/audio/browser` does, over Web Audio, and a
 * test does, over a fake. A game plays through its `system`, and never through the mixer.
 *
 * **Details**
 *
 * Its host drives it with `unlock` and `setHidden`. It prints its loaded sounds, whether it is
 * unlocked, hidden, muted and ducked, and the music it wants.
 *
 * **Example** (A mixer and the system it plays)
 *
 * ```ts
 * import { AudioMixer, AudioSystem } from "arcadekit/audio";
 * import { Effect } from "effect";
 *
 * const program = Effect.gen(function* () {
 *   const mixer = yield* AudioMixer.make({ decode: () => Effect.succeed({ duration: 1 }) });
 *   yield* mixer.system.load({ lap: { file: "/sounds/lap.wav" } });
 *   return mixer;
 * });
 * const mixer = Effect.runSync(Effect.scoped(program));
 * AudioSystem.isAudioSystem(mixer.system); // => true
 * mixer.toJSON(); // => { _id: "AudioMixer", sounds: ["lap"], unlocked: false, hidden: false, muted: false, ducked: false, music: null }
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface AudioMixer extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  /** The audio system the mixer plays: what a game plays through, and what the browser provides. */
  readonly system: AudioSystem.AudioSystem;
}

const DEFAULT_MAX_VOICES = 6;
const DEFAULT_SFX_GAP_MS = 40;
const DEFAULT_DUCKED_MUSIC = 0.35;
const DEFAULT_MUSIC_FADE_SECONDS = 1;
/** Bus and mute changes glide this long, so they don't click. */
const BUS_GLIDE_SECONDS = 0.05;
const LOOP_FADE_IN_SECONDS = 0.15;
const LOOP_FADE_OUT_SECONDS = 0.3;

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/** A sound of the list, with its decoded clip. */
interface Loaded {
  readonly sound: AudioSystem.Sound;
  readonly clip: Clip;
}

/** A voice and its gain, until `endsAt` on the audio clock (Infinity while it loops). */
interface Playing {
  readonly voice: Voice;
  readonly gain: Gain;
  endsAt: number;
}

interface Looping extends Playing {
  volume: number;
}

interface Graph {
  readonly output: Output;
  readonly master: Gain;
  readonly sfx: Gain;
  readonly music: Gain;
}

/** What the module's functions keep, which no caller reads. */
type Internal = Types.Mutable<AudioMixer> & {
  /** Each file's decode, shared by every load that asks for the file while it runs. */
  readonly clips: Cache.Cache<string, Clip, AudioSystem.AudioLoadError>;
  readonly random: Random.Random;
  readonly duckedMusic: number;
  readonly sounds: Map<string, Loaded>;
  readonly volumes: Record<AudioSystem.Bus, number>;
  muted: boolean;
  ducked: boolean;
  hidden: boolean;
  /** Whether its scope has closed: it then plays nothing and can't be unlocked again. */
  closed: boolean;
  /** The output and its buses, once unlocked. */
  graph: Graph | null;
  /** Per sound: its playing one-shots. */
  readonly voices: Map<string, Playing[]>;
  /** Per sound: its last start time. */
  readonly lastStart: Map<string, number>;
  readonly loops: Map<string, Looping>;
  musicId: string | null;
  music: Playing | null;
  /** Voices fading out: music tracks and loops, disposed once they end. */
  fading: Playing[];
};

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: Internal) {
    return {
      _id: "AudioMixer",
      sounds: [...this.sounds.keys()],
      unlocked: this.graph !== null,
      hidden: this.hidden,
      muted: this.muted,
      ducked: this.ducked,
      music: this.musicId,
    };
  },
};

/**
 * Checks whether a value is an audio mixer.
 *
 * **When to use**
 *
 * Narrow an unknown value before unlocking it.
 *
 * **Details**
 *
 * A mixer's `system` is an audio system and no mixer: a game plays through it, and can't unlock
 * or hide it.
 *
 * **Example** (Recognising a mixer)
 *
 * ```ts
 * import { AudioMixer } from "arcadekit/audio";
 * import { Effect } from "effect";
 *
 * const mixer = Effect.runSync(
 *   Effect.scoped(AudioMixer.make({ decode: () => Effect.succeed({ duration: 1 }) }))
 * );
 * AudioMixer.isAudioMixer(mixer); // => true
 * AudioMixer.isAudioMixer(mixer.system); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isAudioMixer = (value: unknown): value is AudioMixer =>
  Predicate.hasProperty(value, TypeId);

const masterValue = (self: Internal): number =>
  self.muted || self.hidden ? 0 : self.volumes.master;

const musicValue = (self: Internal): number =>
  self.volumes.music * (self.ducked ? self.duckedMusic : 1);

const applyBuses = (self: Internal, seconds: number): void => {
  const { graph } = self;
  if (graph === null) {
    return;
  }
  graph.master.ramp(masterValue(self), seconds);
  graph.sfx.ramp(self.volumes.sfx, seconds);
  graph.music.ramp(musicValue(self), seconds);
};

const busOf = (graph: Graph, sound: AudioSystem.Sound): Gain =>
  sound.bus === "music" ? graph.music : graph.sfx;

/** Starts `loaded` at `volume` (fading in over `fadeSeconds` when it is above 0). */
const startVoice = (
  graph: Graph,
  loaded: Loaded,
  volume: number,
  rate: number,
  loop: boolean,
  fadeSeconds: number
): Playing => {
  const gain = graph.output.gain(busOf(graph, loaded.sound));
  if (fadeSeconds > 0) {
    gain.ramp(0, 0);
    gain.ramp(volume, fadeSeconds);
  } else {
    gain.ramp(volume, 0);
  }
  const voice = graph.output.start(loaded.clip, gain, { rate, loop });
  return {
    voice,
    gain,
    endsAt: loop
      ? Number.POSITIVE_INFINITY
      : graph.output.now() + loaded.clip.duration / rate,
  };
};

const fadeOut = (
  self: Internal,
  graph: Graph,
  playing: Playing,
  seconds: number
): void => {
  playing.gain.ramp(0, seconds);
  playing.voice.stop(seconds);
  playing.endsAt = graph.output.now() + seconds;
  self.fading.push(playing);
};

const pruneFading = (self: Internal, now: number): void => {
  if (self.fading.length === 0) {
    return;
  }
  self.fading = self.fading.filter((playing) => {
    if (playing.endsAt > now) {
      return true;
    }
    playing.gain.dispose();
    return false;
  });
};

/** Starts the wanted music track if it is loaded, unlocked and not yet playing. */
const startMusic = (self: Internal, fadeSeconds: number): void => {
  const { graph, musicId } = self;
  if (graph === null || musicId === null || self.music !== null) {
    return;
  }
  const loaded = self.sounds.get(musicId);
  if (loaded === undefined) {
    return;
  }
  self.music = startVoice(
    graph,
    loaded,
    clamp01(loaded.sound.volume ?? 1),
    1,
    true,
    fadeSeconds
  );
};

const play = (
  self: Internal,
  id: string,
  options: { readonly volume?: number } | undefined
): void => {
  const { graph } = self;
  const loaded = self.sounds.get(id);
  if (graph === null || self.hidden || loaded === undefined) {
    return;
  }
  const { sound } = loaded;
  const now = graph.output.now();
  pruneFading(self, now);
  const gapMs =
    sound.minGapMs ?? (sound.bus === "music" ? 0 : DEFAULT_SFX_GAP_MS);
  const last = self.lastStart.get(id);
  if (last !== undefined && (now - last) * 1000 < gapMs) {
    return;
  }
  let playing = self.voices.get(id);
  if (playing === undefined) {
    playing = [];
    self.voices.set(id, playing);
  }
  // Drop the voices that have ended, then respect the cap.
  for (let i = playing.length - 1; i >= 0; i -= 1) {
    const voice = playing[i];
    if (voice !== undefined && voice.endsAt <= now) {
      voice.gain.dispose();
      playing.splice(i, 1);
    }
  }
  if (playing.length >= (sound.maxVoices ?? DEFAULT_MAX_VOICES)) {
    return;
  }
  const pitchJitter = sound.pitchJitter ?? 0;
  const volumeJitter = sound.volumeJitter ?? 0;
  const rate = Math.max(
    0.01,
    1 + (self.random.nextDoubleUnsafe() * 2 - 1) * pitchJitter
  );
  const volume =
    clamp01(sound.volume ?? 1) *
    clamp01(options?.volume ?? 1) *
    (1 - self.random.nextDoubleUnsafe() * clamp01(volumeJitter));
  playing.push(startVoice(graph, loaded, volume, rate, false, 0));
  self.lastStart.set(id, now);
};

const setLoop = (self: Internal, id: string, rawVolume: number): void => {
  const { graph } = self;
  const loaded = self.sounds.get(id);
  if (graph === null || loaded === undefined) {
    return;
  }
  pruneFading(self, graph.output.now());
  const volume = clamp01(rawVolume) * clamp01(loaded.sound.volume ?? 1);
  const loop = self.loops.get(id);
  if (loop === undefined) {
    if (volume > 0) {
      self.loops.set(id, {
        ...startVoice(graph, loaded, volume, 1, true, LOOP_FADE_IN_SECONDS),
        volume,
      });
    }
    return;
  }
  if (volume === loop.volume) {
    return;
  }
  if (volume === 0) {
    self.loops.delete(id);
    fadeOut(self, graph, loop, LOOP_FADE_OUT_SECONDS);
    return;
  }
  loop.gain.ramp(volume, LOOP_FADE_IN_SECONDS);
  loop.volume = volume;
};

const playMusic = (
  self: Internal,
  id: string | null,
  options: { readonly fadeSeconds?: number } | undefined
): void => {
  if (id === self.musicId) {
    return;
  }
  const fadeSeconds = Math.max(
    0,
    options?.fadeSeconds ?? DEFAULT_MUSIC_FADE_SECONDS
  );
  self.musicId = id;
  const { graph } = self;
  if (graph !== null) {
    pruneFading(self, graph.output.now());
    if (self.music !== null) {
      fadeOut(self, graph, self.music, fadeSeconds);
    }
  }
  self.music = null;
  startMusic(self, fadeSeconds);
};

const load = Effect.fnUntraced(function* (
  self: Internal,
  list: AudioSystem.SoundList
) {
  const entries = Object.entries(list);
  // Each file once, even when several ids share it. The cache shares one decode between loads
  // that overlap and keeps every clip, so a file loaded before costs nothing.
  const files = new Set(entries.map(([, sound]) => sound.file));
  const results = yield* Effect.forEach(
    files,
    (file) =>
      Cache.get(self.clips, file).pipe(
        Effect.map((clip) => [file, clip] as const),
        Effect.result
      ),
    { concurrency: 8 }
  );
  const clips = new Map(
    results.filter(Result.isSuccess).map(({ success }) => success)
  );
  // Every sound whose file loaded is added, even when another file failed.
  for (const [id, sound] of entries) {
    const clip = clips.get(sound.file);
    if (clip !== undefined) {
      self.sounds.set(id, { sound, clip });
    }
  }
  // Music asked for before its file loaded starts now.
  startMusic(self, DEFAULT_MUSIC_FADE_SECONDS);
  const failed = results.find(Result.isFailure);
  if (failed !== undefined) {
    return yield* Effect.fail(failed.failure);
  }
});

/** Stops every voice and disconnects every gain: what closing the mixer's scope does. */
const dispose = (self: Internal): void => {
  self.closed = true;
  const { graph } = self;
  self.graph = null;
  if (graph === null) {
    return;
  }
  const all = [
    ...[...self.voices.values()].flat(),
    ...self.loops.values(),
    ...self.fading,
    ...(self.music === null ? [] : [self.music]),
  ];
  for (const playing of all) {
    playing.voice.stop(0);
    playing.gain.dispose();
  }
  self.voices.clear();
  self.loops.clear();
  self.fading = [];
  self.music = null;
  graph.sfx.dispose();
  graph.music.dispose();
  graph.master.dispose();
};

/**
 * Makes a mixer that decodes through `options.decode`, for the life of the scope it runs in. It
 * plays nothing until `unlock`.
 *
 * **When to use**
 *
 * Where a host owns the output it plays into: `arcadekit/audio/browser` makes one in its layer, and
 * a test makes one over a fake output.
 *
 * **Details**
 *
 * It keeps every clip it decodes, one per file the game has loaded, and keeps no failed decode, so
 * a later load tries the file again. It reads Effect's `Random` once, for every play's jitter.
 * When its scope closes it stops every voice and disconnects every gain, and from then on it plays
 * nothing and can't be unlocked again. A trace shows each make as `AudioMixer.make`.
 *
 * **Example** (A mixer over a test's output)
 *
 * ```ts
 * import { AudioMixer } from "arcadekit/audio";
 * import { Effect } from "effect";
 *
 * const started: number[] = [];
 * const output: AudioMixer.Output = {
 *   now: () => 0,
 *   gain: () => ({ ramp: () => {}, dispose: () => {} }),
 *   start: (clip) => {
 *     started.push(clip.duration);
 *     return { stop: () => {} };
 *   },
 * };
 * const program = Effect.gen(function* () {
 *   const mixer = yield* AudioMixer.make({ decode: () => Effect.succeed({ duration: 0.5 }) });
 *   yield* mixer.system.load({ lap: { file: "/sounds/lap.wav" } });
 *   mixer.system.play("lap");
 *   AudioMixer.unlock(mixer, output);
 *   mixer.system.play("lap");
 * });
 * Effect.runSync(Effect.scoped(program));
 * started; // => [0.5]
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make: (
  options: Options
) => Effect.Effect<AudioMixer, never, Scope.Scope> = Effect.fn(
  "AudioMixer.make"
)(function* (options: Options) {
  // A clip is kept for good; a failed decode isn't, so a later load tries the file again. There
  // is no limit: the cache holds one clip per file the game has loaded, the same clips its sounds
  // play, so a limit could only evict a clip in use (the next load of it would decode it again)
  // or a decode still running (an overlapping load would start a second one).
  const clips = yield* Cache.makeWith(options.decode, {
    capacity: Number.POSITIVE_INFINITY,
    timeToLive: (exit) =>
      Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
  });
  const self = Object.create(Proto) as Internal;
  Object.assign(self, {
    clips,
    random: yield* Random.Random,
    duckedMusic: options.duckedMusic ?? DEFAULT_DUCKED_MUSIC,
    sounds: new Map(),
    volumes: { master: 1, sfx: 1, music: 1 },
    muted: false,
    ducked: false,
    hidden: false,
    closed: false,
    graph: null,
    voices: new Map(),
    lastStart: new Map(),
    loops: new Map(),
    musicId: null,
    music: null,
    fading: [],
  });
  self.system = AudioSystem.make({
    play: (id, playOptions) => play(self, id, playOptions),
    setLoop: (id, volume) => setLoop(self, id, volume),
    playMusic: (id, musicOptions) => playMusic(self, id, musicOptions),
    setVolume: (bus, volume) => {
      self.volumes[bus] = clamp01(volume);
      applyBuses(self, BUS_GLIDE_SECONDS);
    },
    setMuted: (muted) => {
      self.muted = muted;
      applyBuses(self, BUS_GLIDE_SECONDS);
    },
    setDucked: (ducked) => {
      self.ducked = ducked;
      applyBuses(self, BUS_GLIDE_SECONDS * 4);
    },
    load: (sounds) => load(self, sounds),
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => dispose(self)));
  return self;
});

/**
 * Starts the mixer making sound into `output`. Plays before this are dropped; music asked for
 * before it starts now, and a loop starts on its next `setLoop`.
 *
 * **When to use**
 *
 * Once, when the host has an output: the browser on the player's first gesture that lets audio
 * start, a test when it is ready to hear.
 *
 * **Details**
 *
 * It makes the master, sfx and music buses, at the volumes and mute set so far. A mixer already
 * unlocked, or whose scope has closed, ignores it.
 *
 * **Example** (Volumes set before the gesture, kept after it)
 *
 * ```ts
 * import { AudioMixer } from "arcadekit/audio";
 * import { Effect } from "effect";
 *
 * const ramps: number[] = [];
 * const output: AudioMixer.Output = {
 *   now: () => 0,
 *   gain: () => ({
 *     ramp: (value) => {
 *       ramps.push(value);
 *     },
 *     dispose: () => {},
 *   }),
 *   start: () => ({ stop: () => {} }),
 * };
 * const program = Effect.gen(function* () {
 *   const mixer = yield* AudioMixer.make({ decode: () => Effect.succeed({ duration: 1 }) });
 *   mixer.system.setVolume("sfx", 0.25);
 *   mixer.pipe(AudioMixer.unlock(output));
 * });
 * Effect.runSync(Effect.scoped(program));
 * ramps; // => [1, 0.25, 1]
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const unlock: {
  (output: Output): (self: AudioMixer) => void;
  (self: AudioMixer, output: Output): void;
} = dual(2, (self: AudioMixer, output: Output): void => {
  const mixer = self as Internal;
  if (mixer.graph !== null || mixer.closed) {
    return;
  }
  const master = output.gain();
  mixer.graph = {
    output,
    master,
    sfx: output.gain(master),
    music: output.gain(master),
  };
  applyBuses(mixer, 0);
  startMusic(mixer, DEFAULT_MUSIC_FADE_SECONDS);
});

/**
 * Silences everything while the page is hidden, or brings it back. Plays while hidden are
 * dropped.
 *
 * **When to use**
 *
 * From the host, each time the page's visibility changes: the browser does it on
 * `visibilitychange`.
 *
 * **Details**
 *
 * Hiding takes the master bus to 0, over the glide every bus change takes; showing it again
 * brings back its volume, or keeps it at 0 while muted. A loop or music keeps playing, unheard.
 *
 * **Example** (A play while hidden is dropped)
 *
 * ```ts
 * import { AudioMixer } from "arcadekit/audio";
 * import { Effect } from "effect";
 *
 * let starts = 0;
 * const output: AudioMixer.Output = {
 *   now: () => 0,
 *   gain: () => ({ ramp: () => {}, dispose: () => {} }),
 *   start: () => {
 *     starts += 1;
 *     return { stop: () => {} };
 *   },
 * };
 * const program = Effect.gen(function* () {
 *   const mixer = yield* AudioMixer.make({ decode: () => Effect.succeed({ duration: 1 }) });
 *   yield* mixer.system.load({ lap: { file: "/sounds/lap.wav" } });
 *   AudioMixer.unlock(mixer, output);
 *   AudioMixer.setHidden(mixer, true);
 *   mixer.system.play("lap");
 * });
 * Effect.runSync(Effect.scoped(program));
 * starts; // => 0
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const setHidden: {
  (hidden: boolean): (self: AudioMixer) => void;
  (self: AudioMixer, hidden: boolean): void;
} = dual(2, (self: AudioMixer, hidden: boolean): void => {
  const mixer = self as Internal;
  mixer.hidden = hidden;
  applyBuses(mixer, BUS_GLIDE_SECONDS);
});
