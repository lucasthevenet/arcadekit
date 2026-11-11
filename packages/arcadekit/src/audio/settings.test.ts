import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  AudioSettings,
  applyAudioSettings,
  defaultAudioSettings,
  silentAudio,
} from "./index";
import type { AudioSystem } from "./index";

// The settings' shape and how an audio system takes them. Keeping them between sessions is a
// `Setting`'s work (arcadekit/save), tested there.

const quiet: AudioSettings = { master: 0.5, sfx: 0.25, music: 0, muted: true };

describe("audio settings", () => {
  it("take volumes from 0 to 1, and their defaults are within them", () => {
    const is = Schema.is(AudioSettings);
    expect([
      is(defaultAudioSettings),
      is(quiet),
      is({ ...quiet, master: 2 }),
      is({ master: 1 }),
    ]).toStrictEqual([true, true, false, false]);
  });
});

describe(applyAudioSettings, () => {
  it("sets each bus volume and mute", () => {
    const calls: unknown[] = [];
    const audio: AudioSystem = {
      ...silentAudio,
      setVolume: (bus, volume) => calls.push([bus, volume]),
      setMuted: (muted) => calls.push(muted),
    };
    applyAudioSettings(audio, quiet);
    expect(calls).toStrictEqual([
      ["master", 0.5],
      ["sfx", 0.25],
      ["music", 0],
      true,
    ]);
  });
});
