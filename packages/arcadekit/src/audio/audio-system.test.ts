import { Effect, Layer, Option } from "effect";
import type { Tracer } from "effect";
import { describe, expect, it } from "vitest";

import { AudioSystem } from "./index";
import type { AudioSettings } from "./index";

// An audio system as a test makes one, the silent one, and what the module writes once over any
// of them: applying the player's settings, and tracing a load. The mixer behind the browser's is
// audio-mixer.test.ts's.

/** The names of a span and of every span above it, the innermost first. */
const spanNames = (span: Tracer.AnySpan): readonly string[] =>
  span._tag === "Span"
    ? [
        span.name,
        ...Option.match(span.parent, { onNone: () => [], onSome: spanNames }),
      ]
    : [];

describe(AudioSystem.make, () => {
  it("calls what it is given, and does nothing for a call it isn't given", () => {
    const calls: unknown[] = [];
    const audio = AudioSystem.make({
      play: (id, options) => calls.push(["play", id, options]),
      setDucked: (ducked) => calls.push(["setDucked", ducked]),
    });
    audio.play("lap", { volume: 0.5 });
    audio.setLoop("engine", 1);
    audio.playMusic("race");
    audio.setVolume("sfx", 0.2);
    audio.setMuted(true);
    audio.setDucked(true);
    expect(calls).toStrictEqual([
      ["play", "lap", { volume: 0.5 }],
      ["setDucked", true],
    ]);
  });

  it("loads with what it is given, traced as AudioSystem.load, and succeeds without one", () => {
    const loaded: unknown[] = [];
    const audio = AudioSystem.make({
      load: (sounds) =>
        Effect.currentSpan.pipe(
          Effect.orDie,
          Effect.map((span) =>
            loaded.push([Object.keys(sounds), spanNames(span)])
          ),
          Effect.asVoid
        ),
    });
    const sounds = { lap: { file: "/sounds/lap.wav" } };
    Effect.runSync(audio.load(sounds));
    expect(loaded).toStrictEqual([[["lap"], ["AudioSystem.load"]]]);
    expect(Effect.runSync(AudioSystem.make({}).load(sounds))).toBeUndefined();
  });

  it("is an audio system, which a look-alike is not, and prints as one", () => {
    const audio = AudioSystem.make({});
    expect([
      AudioSystem.isAudioSystem(audio),
      AudioSystem.isAudioSystem({ ...audio }),
      AudioSystem.isAudioSystem(null),
      audio.toJSON(),
    ]).toStrictEqual([true, false, false, { _id: "AudioSystem" }]);
  });
});

describe("AudioSystem.silent", () => {
  it("loads without decoding and plays nothing", () => {
    expect(
      Effect.runSync(AudioSystem.silent.load({ shot: { file: "shot.wav" } }))
    ).toBeUndefined();
    expect(() => AudioSystem.silent.play("shot")).not.toThrow();
  });

  it("is what layerSilent provides under the AudioSystem key", () => {
    const provided = Effect.runSync(
      Effect.gen(function* () {
        return yield* AudioSystem.AudioSystem;
      }).pipe(Effect.provide(AudioSystem.layerSilent))
    );
    expect([provided, AudioSystem.AudioSystem.key]).toStrictEqual([
      AudioSystem.silent,
      "arcadekit/audio/AudioSystem",
    ]);
  });

  it("is replaced by a test's own system with Layer.succeed", () => {
    const played: string[] = [];
    const recording = Layer.succeed(
      AudioSystem.AudioSystem,
      AudioSystem.make({ play: (id) => played.push(id) })
    );
    Effect.runSync(
      Effect.gen(function* () {
        (yield* AudioSystem.AudioSystem).play("click");
      }).pipe(Effect.provide(recording))
    );
    expect(played).toStrictEqual(["click"]);
  });
});

describe(AudioSystem.applySettings, () => {
  const quiet: AudioSettings.AudioSettings = {
    master: 0.5,
    sfx: 0.25,
    music: 0,
    muted: true,
  };

  it("sets each bus volume and mute, called or piped", () => {
    const calls: unknown[] = [];
    const audio = AudioSystem.make({
      setVolume: (bus, volume) => calls.push([bus, volume]),
      setMuted: (muted) => calls.push(muted),
    });
    AudioSystem.applySettings(audio, quiet);
    const applied = calls.splice(0);
    audio.pipe(AudioSystem.applySettings(quiet));
    expect([applied, calls]).toStrictEqual([
      [["master", 0.5], ["sfx", 0.25], ["music", 0], true],
      [["master", 0.5], ["sfx", 0.25], ["music", 0], true],
    ]);
  });
});
