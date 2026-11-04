import { existsSync } from "node:fs";

import { defaultAudioSettings } from "@gamekit/audio";
import { Effect, Layer } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Story } from "foldkit";
import { describe, expect, it } from "vitest";

import {
  AUDIO_SETTINGS_KEY,
  AudioSettingsLayer,
  AudioSettingsStorage,
  CUE_SOUNDS,
  SOUND_LIST,
} from "./audio";
import { ChangeAudioSettings, EndRun, PlayClick, StartLevel } from "./commands";
import { Message } from "./message";
import { Phase } from "./model";
import type { Model } from "./model";
import { init, update } from "./update";

// The app's sound table, its audio settings under their own key (over an in-memory
// KeyValueStore), and the UI that changes them. Mixing and storage problems are
// @gamekit/audio's tests.

describe("the sound table", () => {
  it("plays every cue with a sound from the list, each a file in public/sounds", () => {
    const ids = Object.values(CUE_SOUNDS);
    expect({
      missing: ids.filter((id) => !Object.hasOwn(SOUND_LIST, id)),
      files: Object.entries(SOUND_LIST).every(
        ([id, { file }]) =>
          file.endsWith(`sounds/${id}.wav`) &&
          existsSync(new URL(`../../public/sounds/${id}.wav`, import.meta.url))
      ),
    }).toStrictEqual({ missing: [], files: true });
  });
});

describe("the audio settings", () => {
  it("keep the last write under their own key, apart from the save", async () => {
    const result = await Effect.gen(function* () {
      const store = yield* AudioSettingsStorage;
      const before = yield* store.load;
      yield* store.save({ ...defaultAudioSettings, music: 0.2 });
      yield* store.save({ ...defaultAudioSettings, muted: true });
      const raw = yield* (yield* KeyValueStore.KeyValueStore).get(
        AUDIO_SETTINGS_KEY
      );
      return { before, after: yield* store.load, stored: raw !== undefined };
    }).pipe(
      Effect.provide(
        AudioSettingsLayer.pipe(Layer.provideMerge(KeyValueStore.layerMemory))
      ),
      Effect.orDie,
      Effect.runPromise
    );
    expect(result).toStrictEqual({
      before: defaultAudioSettings,
      after: { ...defaultAudioSettings, muted: true },
      stored: true,
    });
  });
});

const levelSelect: Model = {
  ...init().model,
  phase: Phase.LevelSelect(),
  levels: [{ id: "first-push", name: "First push" }],
};

describe("the sound controls", () => {
  it("mutes and unmutes on M, saving each change", () => {
    const muted = { ...defaultAudioSettings, muted: true };
    Story.story(
      update,
      Story.given(levelSelect),
      Story.message(Message.PressedMuteKey()),
      Story.model((model) => expect(model.audio).toStrictEqual(muted)),
      Story.Command.expectExact(ChangeAudioSettings({ settings: muted })),
      Story.Command.resolve(
        ChangeAudioSettings,
        Message.CompletedAudioCommand()
      ),
      Story.message(Message.ToggledMute()),
      Story.model((model) => expect(model.audio.muted).toBe(false)),
      Story.Command.resolve(
        ChangeAudioSettings,
        Message.CompletedAudioCommand()
      )
    );
  });

  it("keeps a slider's volume between 0 and 1", () => {
    Story.story(
      update,
      Story.given(levelSelect),
      Story.message(Message.ChangedVolume({ bus: "music", volume: 1.5 })),
      Story.Command.resolve(
        ChangeAudioSettings,
        Message.CompletedAudioCommand()
      ),
      Story.message(Message.ChangedVolume({ bus: "sfx", volume: Number.NaN })),
      Story.model((model) =>
        expect(model.audio).toStrictEqual({
          ...defaultAudioSettings,
          music: 1,
          sfx: 0,
        })
      ),
      Story.Command.resolve(
        ChangeAudioSettings,
        Message.CompletedAudioCommand()
      )
    );
  });

  it("clicks on menu buttons, on top of what they do", () => {
    Story.story(
      update,
      Story.given(levelSelect),
      Story.message(Message.ClickedLevel({ levelId: "first-push" })),
      Story.Command.expectExact(
        StartLevel({ levelId: "first-push" }),
        PlayClick()
      ),
      Story.Command.resolve(StartLevel, Message.StartedRun()),
      Story.Command.resolve(PlayClick, Message.CompletedAudioCommand()),
      Story.model((model) => expect(model.phase._tag).toBe("Playing")),
      Story.message(Message.ClickedLevelSelect()),
      Story.Command.expectExact(EndRun(), PlayClick()),
      Story.Command.resolve(EndRun, Message.CompletedEngineCommand()),
      Story.Command.resolve(PlayClick, Message.CompletedAudioCommand())
    );
  });
});
