import { Effect, Exit, Fiber, Random, Scope } from "effect";
import { describe, expect, it } from "vitest";

import { AudioMixer, AudioSystem } from "./index";

// The mixer runs against a fake output: gains keep the value they ramp to, voices remember
// when they were told to stop, and the clock moves only when a test moves it. Its jitter draws
// from a `Random` that gives the same number every time.

interface FakeGain extends AudioMixer.Gain {
  value: number;
  readonly into: FakeGain | null;
  readonly ramps: { value: number; seconds: number }[];
  disposed: boolean;
}

interface FakeVoice {
  readonly clip: AudioMixer.Clip;
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
  const output: AudioMixer.Output = {
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
const clipOf = (file: string): AudioMixer.Clip => ({
  duration: file.includes("long") ? 10 : 0.5,
});

/** A decode that records each file it decodes and takes a millisecond. */
const slowDecode = (decoded: string[]) => (file: string) =>
  Effect.sync(() => decoded.push(file)).pipe(
    Effect.andThen(Effect.sleep("1 millis")),
    Effect.as(clipOf(file))
  );

const SOUNDS: AudioSystem.SoundList = {
  shot: { file: "shot.wav", maxVoices: 2, minGapMs: 0 },
  hit: { file: "hit.wav", minGapMs: 50 },
  hurt: { file: "hurt.wav", volume: 0.5 },
  hum: { file: "long-hum.wav", volume: 0.5 },
  menu: { file: "long-menu.wav", bus: "music" },
  run: { file: "long-run.wav", bus: "music" },
};

/** A `Random` whose every draw is `value`. */
const drawing = (value: number): Random.Random => ({
  nextDoubleUnsafe: () => value,
  nextIntUnsafe: () => 0,
});

/** Draws every jitter from `drawing(0.5)`, as the tests below do unless they say otherwise. */
const fixedRandom = Effect.provideService(Random.Random, drawing(0.5));

/**
 * Makes a mixer outside Effect, for the tests that only play: in a scope of its own, which
 * `close` closes. Its audio system is what a game plays through.
 */
const makeMixer = (options: AudioMixer.Options, random = 0.5) => {
  const scope = Scope.makeUnsafe();
  const mixer = Effect.runSync(
    AudioMixer.make(options).pipe(
      Scope.provide(scope),
      Effect.provideService(Random.Random, drawing(random))
    )
  );
  return {
    mixer,
    audio: mixer.system,
    close: () => Effect.runSync(Scope.close(scope, Exit.void)),
  };
};

/** A mixer made in the Effect it is yielded in, with the audio system it plays. */
const mixerAndSystem = (options: AudioMixer.Options) =>
  AudioMixer.make(options).pipe(
    Effect.map((mixer) => ({ mixer, audio: mixer.system }))
  );

const setup = (options: { unlocked?: boolean } = {}) => {
  const made = makeMixer({ decode: (file) => Effect.succeed(clipOf(file)) });
  Effect.runSync(made.audio.load(SOUNDS));
  const { fake, output } = makeOutput();
  if (options.unlocked ?? true) {
    AudioMixer.unlock(made.mixer, output);
  }
  return { ...made, fake, output };
};

const playing = (voices: readonly FakeVoice[]) =>
  voices.filter((voice) => voice.stopAt === null);

describe("one-shots", () => {
  it("drop plays before the first gesture unlocks audio", () => {
    const { mixer, audio, fake, output } = setup({ unlocked: false });
    audio.play("shot");
    expect(fake.voices).toHaveLength(0);
    AudioMixer.unlock(mixer, output);
    audio.play("shot");
    expect(fake.voices).toHaveLength(1);
  });

  it("drop unknown ids", () => {
    const { audio, fake } = setup();
    audio.play("nope");
    expect(fake.voices).toHaveLength(0);
  });

  it("cap the voices of one sound until one ends", () => {
    const { audio, fake } = setup();
    audio.play("shot");
    audio.play("shot");
    audio.play("shot");
    expect(fake.voices).toHaveLength(2);
    fake.time = 0.6;
    audio.play("shot");
    expect(fake.voices).toHaveLength(3);
  });

  it("keep a minimum gap between starts of one sound", () => {
    const { audio, fake } = setup();
    audio.play("hit");
    fake.time = 0.03;
    audio.play("hit");
    expect(fake.voices).toHaveLength(1);
    fake.time = 0.05;
    audio.play("hit");
    expect(fake.voices).toHaveLength(2);
  });

  it("apply jitter from the random source and the play's volume", () => {
    const { mixer, audio } = makeMixer(
      { decode: (file) => Effect.succeed(clipOf(file)) },
      1
    );
    Effect.runSync(
      audio.load({
        zap: {
          file: "zap.wav",
          volume: 0.8,
          pitchJitter: 0.1,
          volumeJitter: 0.5,
        },
      })
    );
    const { fake, output } = makeOutput();
    AudioMixer.unlock(mixer, output);
    audio.play("zap", { volume: 0.5 });
    expect(fake.voices[0]?.rate).toBeCloseTo(1.1);
    expect(fake.voices[0]?.gain.value).toBeCloseTo(0.8 * 0.5 * 0.5);
  });

  it("are dropped while the tab is hidden", () => {
    const { mixer, audio, fake } = setup();
    AudioMixer.setHidden(mixer, true);
    audio.play("shot");
    expect(fake.voices).toHaveLength(0);
    AudioMixer.setHidden(mixer, false);
    audio.play("shot");
    expect(fake.voices).toHaveLength(1);
  });
});

describe("buses", () => {
  it("scale each sound by its bus and master volume, and mute silences them", () => {
    const { audio, fake } = setup();
    audio.setVolume("master", 0.5);
    audio.setVolume("sfx", 0.4);
    audio.play("hurt");
    const [voice] = fake.voices;
    if (voice === undefined) {
      throw new Error("no voice");
    }
    expect(loudness(voice)).toBeCloseTo(0.5 * 0.4 * 0.5);
    audio.setMuted(true);
    expect(loudness(voice)).toBe(0);
    audio.setMuted(false);
    expect(loudness(voice)).toBeCloseTo(0.1);
  });

  it("keep volumes set before unlocking", () => {
    const { mixer, audio, fake, output } = setup({ unlocked: false });
    audio.setVolume("sfx", 0.25);
    audio.setMuted(true);
    AudioMixer.unlock(mixer, output);
    audio.play("shot");
    const [voice] = fake.voices;
    expect(voice === undefined ? -1 : loudness(voice)).toBe(0);
    audio.setMuted(false);
    expect(voice === undefined ? -1 : loudness(voice)).toBeCloseTo(0.25);
  });

  it("duck the music but not the sfx", () => {
    const { audio, fake } = setup();
    audio.playMusic("menu");
    audio.play("shot");
    const [music, shot] = fake.voices;
    if (music === undefined || shot === undefined) {
      throw new Error("no voices");
    }
    audio.setDucked(true);
    expect(loudness(music)).toBeCloseTo(0.35);
    expect(loudness(shot)).toBe(1);
    audio.setDucked(false);
    expect(loudness(music)).toBe(1);
  });

  it("go silent while hidden", () => {
    const { mixer, audio, fake } = setup();
    audio.playMusic("menu");
    const [music] = fake.voices;
    AudioMixer.setHidden(mixer, true);
    expect(music === undefined ? -1 : loudness(music)).toBe(0);
    AudioMixer.setHidden(mixer, false);
    expect(music === undefined ? -1 : loudness(music)).toBe(1);
  });
});

describe("music", () => {
  it("crossfades: the old track fades out and stops, the new one fades in", () => {
    const { audio, fake } = setup();
    audio.playMusic("menu");
    fake.time = 5;
    audio.playMusic("run", { fadeSeconds: 2 });
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
    audio.play("shot");
    expect(menu?.gain.disposed).toBe(true);
  });

  it("ignores the track already playing", () => {
    const { audio, fake } = setup();
    audio.playMusic("menu");
    audio.playMusic("menu");
    expect(fake.voices).toHaveLength(1);
    expect(fake.voices[0]?.stopAt).toBeNull();
  });

  it("fades out with null", () => {
    const { audio, fake } = setup();
    audio.playMusic("menu");
    audio.playMusic(null, { fadeSeconds: 0.5 });
    expect(fake.voices).toHaveLength(1);
    expect(fake.voices[0]?.stopAt).toBe(0.5);
  });

  it("asked for before unlocking starts on unlock", () => {
    const { mixer, audio, fake, output } = setup({ unlocked: false });
    audio.playMusic("menu");
    expect(fake.voices).toHaveLength(0);
    AudioMixer.unlock(mixer, output);
    expect(playing(fake.voices)).toHaveLength(1);
  });

  it("asked for before its file loads starts once it loads", () => {
    const { mixer, audio } = makeMixer({
      decode: (file) => Effect.succeed(clipOf(file)),
    });
    const { fake, output } = makeOutput();
    AudioMixer.unlock(mixer, output);
    audio.playMusic("menu");
    expect(fake.voices).toHaveLength(0);
    Effect.runSync(audio.load(SOUNDS));
    expect(fake.voices).toHaveLength(1);
  });
});

describe("loops", () => {
  it("start once and keep playing at the same volume", () => {
    const { audio, fake } = setup();
    audio.setLoop("hum", 1);
    const [hum] = fake.voices;
    const ramps = hum?.gain.ramps.length;
    audio.setLoop("hum", 1);
    expect(fake.voices).toHaveLength(1);
    expect(hum?.loop).toBe(true);
    expect(hum?.gain.value).toBe(0.5);
    expect(hum?.gain.ramps).toHaveLength(ramps ?? -1);
  });

  it("glide to a new volume", () => {
    const { audio, fake } = setup();
    audio.setLoop("hum", 1);
    audio.setLoop("hum", 0.5);
    expect(fake.voices).toHaveLength(1);
    expect(fake.voices[0]?.gain.value).toBe(0.25);
  });

  it("fade out and stop at 0, and start again later", () => {
    const { audio, fake } = setup();
    audio.setLoop("hum", 1);
    audio.setLoop("hum", 0);
    audio.setLoop("hum", 0);
    const [hum] = fake.voices;
    expect(hum?.gain.value).toBe(0);
    expect(hum?.stopAt).toBe(0.3);
    expect(fake.voices).toHaveLength(1);
    audio.setLoop("hum", 1);
    expect(fake.voices).toHaveLength(2);
  });

  it("don't start at 0 or before unlocking", () => {
    const { mixer, audio, fake, output } = setup({ unlocked: false });
    audio.setLoop("hum", 1);
    AudioMixer.unlock(mixer, output);
    audio.setLoop("hum", 0);
    expect(fake.voices).toHaveLength(0);
  });
});

describe("loading", () => {
  it("decodes a file shared by several ids once", () => {
    const decoded: string[] = [];
    Effect.runSync(
      Effect.gen(function* () {
        const { audio } = yield* mixerAndSystem({
          decode: (file) =>
            Effect.sync(() => {
              decoded.push(file);
              return clipOf(file);
            }),
        });
        yield* audio.load({ a: { file: "same.wav" }, b: { file: "same.wav" } });
        yield* audio.load({ c: { file: "same.wav" } });
      }).pipe(Effect.scoped, fixedRandom)
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
        const { audio } = yield* mixerAndSystem({
          decode: (file) =>
            Effect.sync(() => {
              decoded.push(file);
              return clipOf(file);
            }),
        });
        yield* audio.load(list);
        yield* audio.load(list);
      }).pipe(Effect.scoped, fixedRandom)
    );
    expect(decoded).toHaveLength(100);
  });

  it("decodes a shared file once even when decoding takes time", async () => {
    const decoded: string[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const { audio } = yield* mixerAndSystem({
          decode: slowDecode(decoded),
        });
        yield* audio.load({
          a: { file: "same.wav" },
          b: { file: "same.wav" },
          c: { file: "other.wav" },
        });
      }).pipe(Effect.scoped, fixedRandom)
    );
    expect(decoded).toStrictEqual(["same.wav", "other.wav"]);
  });

  it("decodes a file once when two loads of it overlap, and both add its sounds", async () => {
    const decoded: string[] = [];
    const { fake, output } = makeOutput();
    await Effect.runPromise(
      Effect.gen(function* () {
        const { mixer, audio } = yield* mixerAndSystem({
          decode: slowDecode(decoded),
        });
        AudioMixer.unlock(mixer, output);
        yield* Effect.all(
          [
            audio.load({ a: { file: "same.wav" } }),
            audio.load({ b: { file: "same.wav" } }),
          ],
          { concurrency: "unbounded" }
        );
        audio.play("a");
        audio.play("b");
      }).pipe(Effect.scoped, fixedRandom)
    );
    expect(decoded).toStrictEqual(["same.wav"]);
    expect(fake.voices).toHaveLength(2);
  });

  it("decodes a failed file again on the next load", () => {
    const decoded: string[] = [];
    const first = Effect.runSync(
      Effect.gen(function* () {
        const { audio } = yield* mixerAndSystem({
          decode: (file) =>
            Effect.suspend(() => {
              decoded.push(file);
              return decoded.length === 1
                ? Effect.fail(
                    new AudioSystem.AudioLoadError({ file, message: "offline" })
                  )
                : Effect.succeed(clipOf(file));
            }),
        });
        const exit = yield* Effect.exit(audio.load({ a: { file: "a.wav" } }));
        yield* audio.load({ a: { file: "a.wav" } });
        return exit;
      }).pipe(Effect.scoped, fixedRandom)
    );
    expect(Exit.isFailure(first)).toBe(true);
    expect(decoded).toStrictEqual(["a.wav", "a.wav"]);
  });

  it("fails both overlapping loads of a file from one decode, then decodes it again on the next load", async () => {
    const decoded: string[] = [];
    const exits = await Effect.runPromise(
      Effect.gen(function* () {
        const { audio } = yield* mixerAndSystem({
          decode: (file) =>
            Effect.sync(() => decoded.push(file)).pipe(
              Effect.andThen(Effect.sleep("1 millis")),
              Effect.andThen(
                Effect.fail(
                  new AudioSystem.AudioLoadError({ file, message: "offline" })
                )
              )
            ),
        });
        const overlapping = yield* Effect.all(
          [
            Effect.exit(audio.load({ a: { file: "a.wav" } })),
            Effect.exit(audio.load({ b: { file: "a.wav" } })),
          ],
          { concurrency: "unbounded" }
        );
        const later = yield* Effect.exit(audio.load({ c: { file: "a.wav" } }));
        return [...overlapping, later];
      }).pipe(Effect.scoped, fixedRandom)
    );
    expect(exits.map(Exit.isFailure)).toStrictEqual([true, true, true]);
    expect(decoded).toStrictEqual(["a.wav", "a.wav"]);
  });

  it("drops a decode whose load is interrupted, so the next load decodes the file again", async () => {
    const decoded: string[] = [];
    const { fake, output } = makeOutput();
    await Effect.runPromise(
      Effect.gen(function* () {
        const { mixer, audio } = yield* mixerAndSystem({
          // The first decode never ends; the next one does.
          decode: (file) =>
            Effect.suspend(() => {
              decoded.push(file);
              return decoded.length === 1
                ? Effect.never
                : Effect.succeed(clipOf(file));
            }),
        });
        AudioMixer.unlock(mixer, output);
        const first = yield* Effect.forkChild(
          audio.load({ a: { file: "a.wav" } })
        );
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(first);
        yield* audio
          .load({ a: { file: "a.wav" } })
          .pipe(Effect.timeout("1 second"));
        audio.play("a");
      }).pipe(Effect.scoped, fixedRandom)
    );
    expect(decoded).toStrictEqual(["a.wav", "a.wav"]);
    expect(fake.voices).toHaveLength(1);
  });

  it("adds every sound that loads when another file fails", () => {
    const { fake, output } = makeOutput();
    const exit = Effect.runSync(
      Effect.gen(function* () {
        const { mixer, audio } = yield* mixerAndSystem({
          decode: (file) =>
            file === "missing.wav"
              ? Effect.fail(
                  new AudioSystem.AudioLoadError({
                    file,
                    message: `can't load ${file}`,
                  })
                )
              : Effect.succeed(clipOf(file)),
        });
        AudioMixer.unlock(mixer, output);
        const loaded = yield* Effect.exit(
          audio.load({
            broken: { file: "missing.wav" },
            shot: { file: "shot.wav" },
          })
        );
        audio.play("shot");
        audio.play("broken");
        return loaded;
      }).pipe(Effect.scoped, fixedRandom)
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(fake.voices.map(({ clip }) => clip.duration)).toStrictEqual([0.5]);
  });

  it("fails with an AudioLoadError naming the file", () => {
    const error = Effect.runSync(
      Effect.gen(function* () {
        const { audio } = yield* mixerAndSystem({
          decode: (file) =>
            Effect.fail(
              new AudioSystem.AudioLoadError({
                file,
                message: `can't load ${file}`,
              })
            ),
        });
        return yield* Effect.flip(audio.load({ a: { file: "missing.wav" } }));
      }).pipe(Effect.scoped, fixedRandom)
    );
    expect(error).toMatchObject({
      _tag: "AudioLoadError",
      file: "missing.wav",
    });
  });
});

describe("closing its scope", () => {
  it("stops every voice and disconnects every gain, and the mixer can't be unlocked again", () => {
    const { mixer, audio, fake, close } = setup();
    audio.playMusic("menu");
    audio.setLoop("hum", 1);
    audio.play("shot");
    close();
    expect(fake.voices.every((voice) => voice.stopAt !== null)).toBe(true);
    expect(fake.gains.every((gain) => gain.disposed)).toBe(true);
    audio.play("shot");
    expect(fake.voices).toHaveLength(3);
    const again = makeOutput();
    AudioMixer.unlock(mixer, again.output);
    audio.play("shot");
    expect(again.fake.gains).toHaveLength(0);
  });
});

describe("the mixer as data", () => {
  it("is a mixer whose system is an audio system and no mixer, and prints what it holds", () => {
    const { mixer, audio, close } = setup({ unlocked: false });
    audio.setMuted(true);
    audio.playMusic("menu");
    const before = mixer.toJSON();
    AudioMixer.unlock(mixer, makeOutput().output);
    AudioMixer.setHidden(mixer, true);
    const after = mixer.toJSON();
    close();
    expect({
      guards: [
        AudioMixer.isAudioMixer(mixer),
        AudioMixer.isAudioMixer(audio),
        AudioSystem.isAudioSystem(audio),
        AudioMixer.isAudioMixer({ system: audio }),
      ],
      before,
      after,
    }).toStrictEqual({
      guards: [true, false, true, false],
      before: {
        _id: "AudioMixer",
        sounds: ["shot", "hit", "hurt", "hum", "menu", "run"],
        unlocked: false,
        hidden: false,
        muted: true,
        ducked: false,
        music: "menu",
      },
      after: {
        _id: "AudioMixer",
        sounds: ["shot", "hit", "hurt", "hum", "menu", "run"],
        unlocked: true,
        hidden: true,
        muted: true,
        ducked: false,
        music: "menu",
      },
    });
  });
});
