import { Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { AudioLoadError, makeAudioMixer, silentAudio } from "./index";
import type {
  AudioClip,
  AudioGain,
  AudioMixer,
  AudioMixerOptions,
  AudioOutput,
  SoundList,
} from "./index";

// The mixer runs against a fake output: gains keep the value they ramp to, voices remember
// when they were told to stop, and the clock moves only when a test moves it.

interface FakeGain extends AudioGain {
  value: number;
  readonly into: FakeGain | null;
  readonly ramps: { value: number; seconds: number }[];
  disposed: boolean;
}

interface FakeVoice {
  readonly clip: AudioClip;
  readonly gain: FakeGain;
  readonly rate: number;
  readonly loop: boolean;
  stopAt: number | null;
}

const makeOutput = () => {
  const fake = {
    time: 0,
    gains: [] as FakeGain[],
    voices: [] as FakeVoice[],
  };
  const output: AudioOutput = {
    now: () => fake.time,
    gain: (into) => {
      const gain: FakeGain = {
        value: 1,
        into: (into as FakeGain | undefined) ?? null,
        ramps: [],
        disposed: false,
        ramp: (value, seconds) => {
          gain.value = value;
          gain.ramps.push({ value, seconds });
        },
        dispose: () => {
          gain.disposed = true;
        },
      };
      fake.gains.push(gain);
      return gain;
    },
    start: (clip, into, { rate, loop }) => {
      const voice: FakeVoice = {
        clip,
        gain: into as FakeGain,
        rate,
        loop,
        stopAt: null,
      };
      fake.voices.push(voice);
      return {
        stop: (after) => {
          voice.stopAt = fake.time + after;
        },
      };
    },
  };
  return { fake, output };
};

/** How loud a voice is at the speakers: its gain times every gain it feeds through. */
const loudness = (voice: FakeVoice): number => {
  let value = 1;
  for (
    let gain: FakeGain | null = voice.gain;
    gain !== null;
    gain = gain.into
  ) {
    value *= gain.value;
  }
  return value;
};

/** One-shots are 0.5 s long; `long` files (loops, music) 10 s. */
const clipOf = (file: string): AudioClip => ({
  duration: file.includes("long") ? 10 : 0.5,
});

/** A decode that records each file it decodes and takes a millisecond. */
const slowDecode = (decoded: string[]) => (file: string) =>
  Effect.sync(() => decoded.push(file)).pipe(
    Effect.andThen(Effect.sleep("1 millis")),
    Effect.as(clipOf(file))
  );

const SOUNDS: SoundList = {
  shot: { file: "shot.wav", maxVoices: 2, minGapMs: 0 },
  hit: { file: "hit.wav", minGapMs: 50 },
  hurt: { file: "hurt.wav", volume: 0.5 },
  hum: { file: "long-hum.wav", volume: 0.5 },
  menu: { file: "long-menu.wav", bus: "music" },
  run: { file: "long-run.wav", bus: "music" },
};

/** Makes a mixer outside Effect, for the tests that only play. */
const makeMixer = (options: AudioMixerOptions): AudioMixer =>
  Effect.runSync(makeAudioMixer(options));

const setup = (options: { unlocked?: boolean } = {}) => {
  const mixer = makeMixer({
    decode: (file) => Effect.succeed(clipOf(file)),
    random: () => 0.5,
  });
  Effect.runSync(mixer.load(SOUNDS));
  const { fake, output } = makeOutput();
  if (options.unlocked ?? true) {
    mixer.unlock(output);
  }
  return { mixer, fake, output };
};

const playing = (voices: readonly FakeVoice[]) =>
  voices.filter((voice) => voice.stopAt === null);

describe("one-shots", () => {
  it("drop plays before the first gesture unlocks audio", () => {
    const { mixer, fake, output } = setup({ unlocked: false });
    mixer.play("shot");
    expect(fake.voices).toHaveLength(0);
    mixer.unlock(output);
    mixer.play("shot");
    expect(fake.voices).toHaveLength(1);
  });

  it("drop unknown ids", () => {
    const { mixer, fake } = setup();
    mixer.play("nope");
    expect(fake.voices).toHaveLength(0);
  });

  it("cap the voices of one sound until one ends", () => {
    const { mixer, fake } = setup();
    mixer.play("shot");
    mixer.play("shot");
    mixer.play("shot");
    expect(fake.voices).toHaveLength(2);
    fake.time = 0.6;
    mixer.play("shot");
    expect(fake.voices).toHaveLength(3);
  });

  it("keep a minimum gap between starts of one sound", () => {
    const { mixer, fake } = setup();
    mixer.play("hit");
    fake.time = 0.03;
    mixer.play("hit");
    expect(fake.voices).toHaveLength(1);
    fake.time = 0.05;
    mixer.play("hit");
    expect(fake.voices).toHaveLength(2);
  });

  it("apply jitter from the random source and the play's volume", () => {
    const mixer = makeMixer({
      decode: (file) => Effect.succeed(clipOf(file)),
      random: () => 1,
    });
    Effect.runSync(
      mixer.load({
        zap: {
          file: "zap.wav",
          volume: 0.8,
          pitchJitter: 0.1,
          volumeJitter: 0.5,
        },
      })
    );
    const { fake, output } = makeOutput();
    mixer.unlock(output);
    mixer.play("zap", { volume: 0.5 });
    expect(fake.voices[0]?.rate).toBeCloseTo(1.1);
    expect(fake.voices[0]?.gain.value).toBeCloseTo(0.8 * 0.5 * 0.5);
  });

  it("are dropped while the tab is hidden", () => {
    const { mixer, fake } = setup();
    mixer.setHidden(true);
    mixer.play("shot");
    expect(fake.voices).toHaveLength(0);
    mixer.setHidden(false);
    mixer.play("shot");
    expect(fake.voices).toHaveLength(1);
  });
});

describe("buses", () => {
  it("scale each sound by its bus and master volume, and mute silences them", () => {
    const { mixer, fake } = setup();
    mixer.setVolume("master", 0.5);
    mixer.setVolume("sfx", 0.4);
    mixer.play("hurt");
    const [voice] = fake.voices;
    if (voice === undefined) {
      throw new Error("no voice");
    }
    expect(loudness(voice)).toBeCloseTo(0.5 * 0.4 * 0.5);
    mixer.setMuted(true);
    expect(loudness(voice)).toBe(0);
    mixer.setMuted(false);
    expect(loudness(voice)).toBeCloseTo(0.1);
  });

  it("keep volumes set before unlocking", () => {
    const { mixer, fake, output } = setup({ unlocked: false });
    mixer.setVolume("sfx", 0.25);
    mixer.setMuted(true);
    mixer.unlock(output);
    mixer.play("shot");
    const [voice] = fake.voices;
    expect(voice === undefined ? -1 : loudness(voice)).toBe(0);
    mixer.setMuted(false);
    expect(voice === undefined ? -1 : loudness(voice)).toBeCloseTo(0.25);
  });

  it("duck the music but not the sfx", () => {
    const { mixer, fake } = setup();
    mixer.playMusic("menu");
    mixer.play("shot");
    const [music, shot] = fake.voices;
    if (music === undefined || shot === undefined) {
      throw new Error("no voices");
    }
    mixer.setDucked(true);
    expect(loudness(music)).toBeCloseTo(0.35);
    expect(loudness(shot)).toBe(1);
    mixer.setDucked(false);
    expect(loudness(music)).toBe(1);
  });

  it("go silent while hidden", () => {
    const { mixer, fake } = setup();
    mixer.playMusic("menu");
    const [music] = fake.voices;
    mixer.setHidden(true);
    expect(music === undefined ? -1 : loudness(music)).toBe(0);
    mixer.setHidden(false);
    expect(music === undefined ? -1 : loudness(music)).toBe(1);
  });
});

describe("music", () => {
  it("crossfades: the old track fades out and stops, the new one fades in", () => {
    const { mixer, fake } = setup();
    mixer.playMusic("menu");
    fake.time = 5;
    mixer.playMusic("run", { fadeSeconds: 2 });
    const [menu, run] = fake.voices;
    expect(menu?.stopAt).toBe(7);
    expect(menu?.gain.ramps.at(-1)).toStrictEqual({ value: 0, seconds: 2 });
    expect(run?.loop).toBe(true);
    expect(run?.gain.ramps).toStrictEqual([
      { value: 0, seconds: 0 },
      { value: 1, seconds: 2 },
    ]);
    // The faded-out track's gain is disconnected once it has ended.
    fake.time = 7;
    mixer.play("shot");
    expect(menu?.gain.disposed).toBe(true);
  });

  it("ignores the track already playing", () => {
    const { mixer, fake } = setup();
    mixer.playMusic("menu");
    mixer.playMusic("menu");
    expect(fake.voices).toHaveLength(1);
    expect(fake.voices[0]?.stopAt).toBeNull();
  });

  it("fades out with null", () => {
    const { mixer, fake } = setup();
    mixer.playMusic("menu");
    mixer.playMusic(null, { fadeSeconds: 0.5 });
    expect(fake.voices).toHaveLength(1);
    expect(fake.voices[0]?.stopAt).toBe(0.5);
  });

  it("asked for before unlocking starts on unlock", () => {
    const { mixer, fake, output } = setup({ unlocked: false });
    mixer.playMusic("menu");
    expect(fake.voices).toHaveLength(0);
    mixer.unlock(output);
    expect(playing(fake.voices)).toHaveLength(1);
  });

  it("asked for before its file loads starts once it loads", () => {
    const mixer = makeMixer({
      decode: (file) => Effect.succeed(clipOf(file)),
      random: () => 0.5,
    });
    const { fake, output } = makeOutput();
    mixer.unlock(output);
    mixer.playMusic("menu");
    expect(fake.voices).toHaveLength(0);
    Effect.runSync(mixer.load(SOUNDS));
    expect(fake.voices).toHaveLength(1);
  });
});

describe("loops", () => {
  it("start once and keep playing at the same volume", () => {
    const { mixer, fake } = setup();
    mixer.setLoop("hum", 1);
    const [hum] = fake.voices;
    const ramps = hum?.gain.ramps.length;
    mixer.setLoop("hum", 1);
    expect(fake.voices).toHaveLength(1);
    expect(hum?.loop).toBe(true);
    expect(hum?.gain.value).toBe(0.5);
    expect(hum?.gain.ramps).toHaveLength(ramps ?? -1);
  });

  it("glide to a new volume", () => {
    const { mixer, fake } = setup();
    mixer.setLoop("hum", 1);
    mixer.setLoop("hum", 0.5);
    expect(fake.voices).toHaveLength(1);
    expect(fake.voices[0]?.gain.value).toBe(0.25);
  });

  it("fade out and stop at 0, and start again later", () => {
    const { mixer, fake } = setup();
    mixer.setLoop("hum", 1);
    mixer.setLoop("hum", 0);
    mixer.setLoop("hum", 0);
    const [hum] = fake.voices;
    expect(hum?.gain.value).toBe(0);
    expect(hum?.stopAt).toBe(0.3);
    expect(fake.voices).toHaveLength(1);
    mixer.setLoop("hum", 1);
    expect(fake.voices).toHaveLength(2);
  });

  it("don't start at 0 or before unlocking", () => {
    const { mixer, fake, output } = setup({ unlocked: false });
    mixer.setLoop("hum", 1);
    mixer.unlock(output);
    mixer.setLoop("hum", 0);
    expect(fake.voices).toHaveLength(0);
  });
});

describe("loading", () => {
  it("decodes a file shared by several ids once", () => {
    const decoded: string[] = [];
    Effect.runSync(
      Effect.gen(function* () {
        const mixer = yield* makeAudioMixer({
          decode: (file) =>
            Effect.sync(() => {
              decoded.push(file);
              return clipOf(file);
            }),
          random: () => 0.5,
        });
        yield* mixer.load({ a: { file: "same.wav" }, b: { file: "same.wav" } });
        yield* mixer.load({ c: { file: "same.wav" } });
      })
    );
    expect(decoded).toStrictEqual(["same.wav"]);
  });

  it("never decodes a loaded file again, however many files the game has", () => {
    const decoded: string[] = [];
    const list: Record<string, { file: string }> = {};
    for (let i = 0; i < 100; i += 1) {
      list[`sound${i}`] = { file: `sound${i}.wav` };
    }
    Effect.runSync(
      Effect.gen(function* () {
        const mixer = yield* makeAudioMixer({
          decode: (file) =>
            Effect.sync(() => {
              decoded.push(file);
              return clipOf(file);
            }),
          random: () => 0.5,
        });
        yield* mixer.load(list);
        yield* mixer.load(list);
      })
    );
    expect(decoded).toHaveLength(100);
  });

  it("decodes a shared file once even when decoding takes time", async () => {
    const decoded: string[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const mixer = yield* makeAudioMixer({
          decode: slowDecode(decoded),
          random: () => 0.5,
        });
        yield* mixer.load({
          a: { file: "same.wav" },
          b: { file: "same.wav" },
          c: { file: "other.wav" },
        });
      })
    );
    expect(decoded).toStrictEqual(["same.wav", "other.wav"]);
  });

  it("decodes a file once when two loads of it overlap, and both add its sounds", async () => {
    const decoded: string[] = [];
    const { fake, output } = makeOutput();
    await Effect.runPromise(
      Effect.gen(function* () {
        const mixer = yield* makeAudioMixer({
          decode: slowDecode(decoded),
          random: () => 0.5,
        });
        mixer.unlock(output);
        yield* Effect.all(
          [
            mixer.load({ a: { file: "same.wav" } }),
            mixer.load({ b: { file: "same.wav" } }),
          ],
          { concurrency: "unbounded" }
        );
        mixer.play("a");
        mixer.play("b");
      })
    );
    expect(decoded).toStrictEqual(["same.wav"]);
    expect(fake.voices).toHaveLength(2);
  });

  it("decodes a failed file again on the next load", () => {
    const decoded: string[] = [];
    const first = Effect.runSync(
      Effect.gen(function* () {
        const mixer = yield* makeAudioMixer({
          decode: (file) =>
            Effect.suspend(() => {
              decoded.push(file);
              return decoded.length === 1
                ? Effect.fail(new AudioLoadError({ file, message: "offline" }))
                : Effect.succeed(clipOf(file));
            }),
          random: () => 0.5,
        });
        const exit = yield* Effect.exit(mixer.load({ a: { file: "a.wav" } }));
        yield* mixer.load({ a: { file: "a.wav" } });
        return exit;
      })
    );
    expect(Exit.isFailure(first)).toBe(true);
    expect(decoded).toStrictEqual(["a.wav", "a.wav"]);
  });

  it("fails both overlapping loads of a file from one decode, then decodes it again on the next load", async () => {
    const decoded: string[] = [];
    const exits = await Effect.runPromise(
      Effect.gen(function* () {
        const mixer = yield* makeAudioMixer({
          decode: (file) =>
            Effect.sync(() => decoded.push(file)).pipe(
              Effect.andThen(Effect.sleep("1 millis")),
              Effect.andThen(
                Effect.fail(new AudioLoadError({ file, message: "offline" }))
              )
            ),
          random: () => 0.5,
        });
        const overlapping = yield* Effect.all(
          [
            Effect.exit(mixer.load({ a: { file: "a.wav" } })),
            Effect.exit(mixer.load({ b: { file: "a.wav" } })),
          ],
          { concurrency: "unbounded" }
        );
        const later = yield* Effect.exit(mixer.load({ c: { file: "a.wav" } }));
        return [...overlapping, later];
      })
    );
    expect(exits.map(Exit.isFailure)).toStrictEqual([true, true, true]);
    expect(decoded).toStrictEqual(["a.wav", "a.wav"]);
  });

  it("drops a decode whose load is interrupted, so the next load decodes the file again", async () => {
    const decoded: string[] = [];
    const { fake, output } = makeOutput();
    await Effect.runPromise(
      Effect.gen(function* () {
        const mixer = yield* makeAudioMixer({
          // The first decode never ends; the next one does.
          decode: (file) =>
            Effect.suspend(() => {
              decoded.push(file);
              return decoded.length === 1
                ? Effect.never
                : Effect.succeed(clipOf(file));
            }),
          random: () => 0.5,
        });
        mixer.unlock(output);
        const first = yield* Effect.forkChild(
          mixer.load({ a: { file: "a.wav" } })
        );
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(first);
        yield* mixer
          .load({ a: { file: "a.wav" } })
          .pipe(Effect.timeout("1 second"));
        mixer.play("a");
      })
    );
    expect(decoded).toStrictEqual(["a.wav", "a.wav"]);
    expect(fake.voices).toHaveLength(1);
  });

  it("adds every sound that loads when another file fails", () => {
    const { fake, output } = makeOutput();
    const exit = Effect.runSync(
      Effect.gen(function* () {
        const mixer = yield* makeAudioMixer({
          decode: (file) =>
            file === "missing.wav"
              ? Effect.fail(
                  new AudioLoadError({ file, message: `can't load ${file}` })
                )
              : Effect.succeed(clipOf(file)),
          random: () => 0.5,
        });
        mixer.unlock(output);
        const loaded = yield* Effect.exit(
          mixer.load({
            broken: { file: "missing.wav" },
            shot: { file: "shot.wav" },
          })
        );
        mixer.play("shot");
        mixer.play("broken");
        return loaded;
      })
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(fake.voices.map(({ clip }) => clip.duration)).toStrictEqual([0.5]);
  });

  it("fails with an AudioLoadError naming the file", () => {
    const error = Effect.runSync(
      Effect.gen(function* () {
        const mixer = yield* makeAudioMixer({
          decode: (file) =>
            Effect.fail(
              new AudioLoadError({ file, message: `can't load ${file}` })
            ),
          random: () => 0.5,
        });
        return yield* Effect.flip(mixer.load({ a: { file: "missing.wav" } }));
      })
    );
    expect(error).toMatchObject({
      _tag: "AudioLoadError",
      file: "missing.wav",
    });
  });

  it("the silent system loads without decoding and plays nothing", () => {
    expect(Effect.runSync(silentAudio.load(SOUNDS))).toBeUndefined();
    expect(() => silentAudio.play("shot")).not.toThrow();
  });
});

describe("dispose", () => {
  it("stops every voice and disconnects every gain", () => {
    const { mixer, fake } = setup();
    mixer.playMusic("menu");
    mixer.setLoop("hum", 1);
    mixer.play("shot");
    mixer.dispose();
    expect(fake.voices.every((voice) => voice.stopAt !== null)).toBe(true);
    expect(fake.gains.every((gain) => gain.disposed)).toBe(true);
    mixer.play("shot");
    expect(fake.voices).toHaveLength(3);
  });
});
