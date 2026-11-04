import { Data, Effect, Result } from "effect";

// The audio system: what apps and sound views call, and the plain-TypeScript mixer behind
// it. The mixer never touches Web Audio itself. It drives an `AudioOutput` (the browser
// entry wraps an AudioContext; tests pass a fake) and decodes through an injected function,
// so all of its rules (unlock, voice limits, buses, crossfades) run in a plain test.

/** A bus a sound plays through. Every bus feeds `master`. */
export type AudioBus = "master" | "sfx" | "music";

/** One sound: its file and how it plays. */
export interface SoundDef {
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

/** A game's sounds by id. */
export type SoundList = Readonly<Record<string, SoundDef>>;

/** A sound file that couldn't be fetched or decoded. */
export class AudioLoadError extends Data.TaggedError("AudioLoadError")<{
  readonly file: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * What apps and sound views call. Every call except `load` is plain and synchronous, so a
 * view can play during `render`. Calls never throw: an unknown or not yet loaded id, or a
 * play before the first gesture unlocks audio, is dropped silently.
 */
export interface AudioSystem {
  /** Plays a one-shot sound once. `volume` (0 to 1) scales its own volume, such as quieter for a teammate's hurt. */
  readonly play: (id: string, options?: { readonly volume?: number }) => void;
  /**
   * Keeps a looping sound playing at `volume` (0 to 1, times its own volume). Call it every
   * frame with the volume you want: the same volume again changes nothing, a new one glides to
   * it, and 0 fades the loop out and stops it.
   */
  readonly setLoop: (id: string, volume: number) => void;
  /** Crossfades to music track `id` (looping), or fades the music out with null. The track already playing is a no-op. */
  readonly playMusic: (
    id: string | null,
    options?: { readonly fadeSeconds?: number }
  ) => void;
  /** Sets a bus's volume, 0 to 1. */
  readonly setVolume: (bus: AudioBus, volume: number) => void;
  /** Silences everything, or brings it back. */
  readonly setMuted: (muted: boolean) => void;
  /** Lowers the music, such as while the game is paused. */
  readonly setDucked: (ducked: boolean) => void;
  /**
   * Fetches and decodes sounds and adds them by id. A file shared by several ids is loaded once.
   * Every sound whose file loads is added; if any file fails, it then fails with the first error.
   */
  readonly load: (sounds: SoundList) => Effect.Effect<void, AudioLoadError>;
}

// The output the mixer drives: a small part of Web Audio.

/** A decoded sound. Web Audio's `AudioBuffer` is one. */
export interface AudioClip {
  /** Its length in seconds. */
  readonly duration: number;
}

/** A gain stage: a bus, or one voice's own volume. */
export interface AudioGain {
  /** Moves the gain to `value` over `seconds`, from now (0 sets it at once). */
  readonly ramp: (value: number, seconds: number) => void;
  /** Disconnects it. */
  readonly dispose: () => void;
}

/** One playing clip. */
export interface AudioVoice {
  /** Stops it `afterSeconds` from now. */
  readonly stop: (afterSeconds: number) => void;
}

/** Where the mixer's sound goes. The browser entry builds one over an AudioContext on the first gesture. */
export interface AudioOutput {
  /** The audio clock, in seconds. Voice limits and fades are timed on it. */
  readonly now: () => number;
  /** A new gain, at 1, feeding `into`, or the speakers when it is omitted. */
  readonly gain: (into?: AudioGain) => AudioGain;
  /** Starts `clip` now into `into`, at playback speed `rate`. */
  readonly start: (
    clip: AudioClip,
    into: AudioGain,
    options: { readonly rate: number; readonly loop: boolean }
  ) => AudioVoice;
}

/** What the mixer needs besides an output. */
export interface AudioMixerOptions {
  /** Fetches and decodes one file. */
  readonly decode: (file: string) => Effect.Effect<AudioClip, AudioLoadError>;
  /** A number in [0, 1), for jitter. Presentation only, so `Math.random` is fine. */
  readonly random: () => number;
  /** How loud the music is while ducked, as a share of its volume. Defaults to 0.35. */
  readonly duckedMusic?: number;
}

/** The audio system plus the controls its host (the browser entry, a test) drives. */
export interface AudioMixer extends AudioSystem {
  /** Starts making sound into `output`. Plays before this are dropped; music asked for before it starts now, and a loop starts on its next `setLoop`. */
  readonly unlock: (output: AudioOutput) => void;
  /** Silences everything while the page is hidden. Plays while hidden are dropped. */
  readonly setHidden: (hidden: boolean) => void;
  /** Stops everything and disconnects. */
  readonly dispose: () => void;
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

interface Sound {
  readonly def: SoundDef;
  readonly clip: AudioClip;
}

/** A voice and its gain, until `endsAt` on the audio clock (Infinity while it loops). */
interface Voice {
  readonly voice: AudioVoice;
  readonly gain: AudioGain;
  endsAt: number;
}

interface Loop extends Voice {
  volume: number;
}

interface Graph {
  readonly output: AudioOutput;
  readonly master: AudioGain;
  readonly sfx: AudioGain;
  readonly music: AudioGain;
}

/** Builds the audio system's mixer. It is silent until `unlock`. */
export const makeAudioMixer = (options: AudioMixerOptions): AudioMixer => {
  const duckedMusic = options.duckedMusic ?? DEFAULT_DUCKED_MUSIC;
  const sounds = new Map<string, Sound>();
  const clips = new Map<string, AudioClip>();
  const volumes = { master: 1, sfx: 1, music: 1 };
  let muted = false;
  let ducked = false;
  let hidden = false;
  let graph: Graph | null = null;

  // Per sound: its playing one-shots and its last start time.
  const voices = new Map<string, Voice[]>();
  const lastStart = new Map<string, number>();
  const loops = new Map<string, Loop>();
  let musicId: string | null = null;
  let music: Voice | null = null;
  // Voices fading out: music tracks and loops, disposed once they end.
  let fading: Voice[] = [];

  const masterValue = () => (muted || hidden ? 0 : volumes.master);
  const musicValue = () => volumes.music * (ducked ? duckedMusic : 1);

  const applyBuses = (seconds: number) => {
    if (graph === null) {
      return;
    }
    graph.master.ramp(masterValue(), seconds);
    graph.sfx.ramp(volumes.sfx, seconds);
    graph.music.ramp(musicValue(), seconds);
  };

  const busOf = (g: Graph, def: SoundDef) =>
    def.bus === "music" ? g.music : g.sfx;

  /** Starts `sound` at `volume` (fading in over `fadeSeconds` when it is above 0). */
  const startVoice = (
    g: Graph,
    sound: Sound,
    volume: number,
    rate: number,
    loop: boolean,
    fadeSeconds: number
  ): Voice => {
    const gain = g.output.gain(busOf(g, sound.def));
    if (fadeSeconds > 0) {
      gain.ramp(0, 0);
      gain.ramp(volume, fadeSeconds);
    } else {
      gain.ramp(volume, 0);
    }
    const voice = g.output.start(sound.clip, gain, { rate, loop });
    return {
      voice,
      gain,
      endsAt: loop
        ? Number.POSITIVE_INFINITY
        : g.output.now() + sound.clip.duration / rate,
    };
  };

  const fadeOut = (g: Graph, playing: Voice, seconds: number) => {
    playing.gain.ramp(0, seconds);
    playing.voice.stop(seconds);
    playing.endsAt = g.output.now() + seconds;
    fading.push(playing);
  };

  const pruneFading = (now: number) => {
    if (fading.length === 0) {
      return;
    }
    fading = fading.filter((playing) => {
      if (playing.endsAt > now) {
        return true;
      }
      playing.gain.dispose();
      return false;
    });
  };

  /** Starts the wanted music track if it is loaded, unlocked and not yet playing. */
  const startMusic = (fadeSeconds: number) => {
    if (graph === null || musicId === null || music !== null) {
      return;
    }
    const sound = sounds.get(musicId);
    if (sound === undefined) {
      return;
    }
    music = startVoice(
      graph,
      sound,
      clamp01(sound.def.volume ?? 1),
      1,
      true,
      fadeSeconds
    );
  };

  const system: AudioMixer = {
    play: (id, playOptions) => {
      const g = graph;
      const sound = sounds.get(id);
      if (g === null || hidden || sound === undefined) {
        return;
      }
      const { def } = sound;
      const now = g.output.now();
      pruneFading(now);
      const gapMs =
        def.minGapMs ?? (def.bus === "music" ? 0 : DEFAULT_SFX_GAP_MS);
      const last = lastStart.get(id);
      if (last !== undefined && (now - last) * 1000 < gapMs) {
        return;
      }
      let playing = voices.get(id);
      if (playing === undefined) {
        playing = [];
        voices.set(id, playing);
      }
      // Drop the voices that have ended, then respect the cap.
      for (let i = playing.length - 1; i >= 0; i -= 1) {
        const voice = playing[i];
        if (voice !== undefined && voice.endsAt <= now) {
          voice.gain.dispose();
          playing.splice(i, 1);
        }
      }
      if (playing.length >= (def.maxVoices ?? DEFAULT_MAX_VOICES)) {
        return;
      }
      const pitchJitter = def.pitchJitter ?? 0;
      const volumeJitter = def.volumeJitter ?? 0;
      const rate = Math.max(0.01, 1 + (options.random() * 2 - 1) * pitchJitter);
      const volume =
        clamp01(def.volume ?? 1) *
        clamp01(playOptions?.volume ?? 1) *
        (1 - options.random() * clamp01(volumeJitter));
      playing.push(startVoice(g, sound, volume, rate, false, 0));
      lastStart.set(id, now);
    },

    setLoop: (id, rawVolume) => {
      const g = graph;
      const sound = sounds.get(id);
      if (g === null || sound === undefined) {
        return;
      }
      pruneFading(g.output.now());
      const volume = clamp01(rawVolume) * clamp01(sound.def.volume ?? 1);
      const loop = loops.get(id);
      if (loop === undefined) {
        if (volume > 0) {
          loops.set(id, {
            ...startVoice(g, sound, volume, 1, true, LOOP_FADE_IN_SECONDS),
            volume,
          });
        }
        return;
      }
      if (volume === loop.volume) {
        return;
      }
      if (volume === 0) {
        loops.delete(id);
        fadeOut(g, loop, LOOP_FADE_OUT_SECONDS);
        return;
      }
      loop.gain.ramp(volume, LOOP_FADE_IN_SECONDS);
      loop.volume = volume;
    },

    playMusic: (id, musicOptions) => {
      if (id === musicId) {
        return;
      }
      const fadeSeconds = Math.max(
        0,
        musicOptions?.fadeSeconds ?? DEFAULT_MUSIC_FADE_SECONDS
      );
      musicId = id;
      if (graph !== null) {
        pruneFading(graph.output.now());
        if (music !== null) {
          fadeOut(graph, music, fadeSeconds);
        }
      }
      music = null;
      startMusic(fadeSeconds);
    },

    setVolume: (bus, volume) => {
      volumes[bus] = clamp01(volume);
      applyBuses(BUS_GLIDE_SECONDS);
    },

    setMuted: (value) => {
      muted = value;
      applyBuses(BUS_GLIDE_SECONDS);
    },

    setDucked: (value) => {
      ducked = value;
      applyBuses(BUS_GLIDE_SECONDS * 4);
    },

    load: (list) =>
      Effect.suspend(() => {
        const entries = Object.entries(list);
        // Each file once, even when several ids share it and decodes run at the same time.
        const files = [...new Set(entries.map(([, def]) => def.file))].filter(
          (file) => !clips.has(file)
        );
        return Effect.forEach(
          files,
          (file) =>
            options.decode(file).pipe(
              Effect.tap((clip) => Effect.sync(() => clips.set(file, clip))),
              Effect.result
            ),
          { concurrency: 8 }
        ).pipe(
          Effect.flatMap((results) => {
            // Every sound whose file loaded is added, even when another file failed.
            for (const [id, def] of entries) {
              const clip = clips.get(def.file);
              if (clip !== undefined) {
                sounds.set(id, { def, clip });
              }
            }
            // Music asked for before its file loaded starts now.
            startMusic(DEFAULT_MUSIC_FADE_SECONDS);
            const failed = results.find(Result.isFailure);
            return failed === undefined
              ? Effect.void
              : Effect.fail(failed.failure);
          })
        );
      }),

    unlock: (output) => {
      if (graph !== null) {
        return;
      }
      const master = output.gain();
      graph = {
        output,
        master,
        sfx: output.gain(master),
        music: output.gain(master),
      };
      applyBuses(0);
      startMusic(DEFAULT_MUSIC_FADE_SECONDS);
    },

    setHidden: (value) => {
      hidden = value;
      applyBuses(BUS_GLIDE_SECONDS);
    },

    dispose: () => {
      const g = graph;
      graph = null;
      if (g === null) {
        return;
      }
      const all = [
        ...[...voices.values()].flat(),
        ...loops.values(),
        ...fading,
        ...(music === null ? [] : [music]),
      ];
      for (const playing of all) {
        playing.voice.stop(0);
        playing.gain.dispose();
      }
      voices.clear();
      loops.clear();
      fading = [];
      music = null;
      g.sfx.dispose();
      g.music.dispose();
      g.master.dispose();
    },
  };
  return system;
};
