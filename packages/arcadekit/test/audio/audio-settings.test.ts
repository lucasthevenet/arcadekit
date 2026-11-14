import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { AudioSettings } from "../../src/audio/index";

// The settings' shape and what they are before the player changes anything. How an audio system
// takes them is audio-system.test.ts's, and keeping them between sessions is a `Setting`'s work
// (arcadekit/save), tested there.

const quiet: AudioSettings.AudioSettings = {
  master: 0.5,
  sfx: 0.25,
  music: 0,
  muted: true,
};

describe("the audio settings", () => {
  it("take volumes from 0 to 1, and their defaults are within them", () => {
    const is = Schema.is(AudioSettings.AudioSettings);
    expect([
      is(AudioSettings.defaults),
      is(quiet),
      is({ ...quiet, master: 2 }),
      is({ master: 1 }),
    ]).toStrictEqual([true, true, false, false]);
  });
});
