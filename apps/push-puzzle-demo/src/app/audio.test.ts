import { existsSync } from "node:fs";

import { Audio, defaultAudioSettings, silentAudio } from "arcadekit/audio";
import type { AudioSystem } from "arcadekit/audio";
import { Effect, Layer } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Story } from "foldkit";
import { describe, expect, it } from "vitest";

import { CUE_SOUNDS, PushPuzzleAudioSettings, SOUND_LIST } from "./audio";
import {
  ChangeAudioSettings,
  EndRun,
  LoadAudioSettings,
  PlayClick,
  StartLevel,
} from "./commands";
import { Message } from "./message";
import { Phase } from "./model";
import type { Model } from "./model";
import { init, update } from "./update";

// The sounds the app gives the cue table, its audio settings under their own key (over
// an in-memory KeyValueStore, through the Commands the app runs), and the UI that changes
// them. Mixing is arcadekit/audio's tests, and storage problems are arcadekit/save's.

/** The audio settings' storage key, written out: moving it would leave what is stored behind. */
const SETTINGS_KEY = "arcadekit/push-puzzle/settings";

describe("the sounds", () => {
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
  it("keep the last write under their own key, apart from the save, and are applied when read", async () => {
    const applied: unknown[] = [];
    const audio: AudioSystem = {
      ...silentAudio,
      setVolume: (bus, volume) => {
        applied.push([bus, volume]);
      },
      setMuted: (muted) => {
        applied.push(muted);
      },
    };
    const muted = { ...defaultAudioSettings, muted: true };
    const result = await Effect.gen(function* () {
      const before = (yield* LoadAudioSettings().effect).settings;
      yield* ChangeAudioSettings({
        settings: { ...defaultAudioSettings, music: 0.2 },
      }).effect;
      yield* ChangeAudioSettings({ settings: muted }).effect;
      const raw = yield* (yield* KeyValueStore.KeyValueStore).get(SETTINGS_KEY);
      applied.length = 0;
      const after = (yield* LoadAudioSettings().effect).settings;
      return { before, after, raw, applied };
    }).pipe(
      Effect.provide(
        PushPuzzleAudioSettings.layer.pipe(
          Layer.provideMerge(KeyValueStore.layerMemory)
        )
      ),
      Effect.provide(Layer.succeed(Audio, audio)),
      Effect.orDie,
      Effect.runPromise
    );
    expect(result).toStrictEqual({
      before: defaultAudioSettings,
      after: muted,
      raw: JSON.stringify(muted),
      applied: [
        ["master", muted.master],
        ["sfx", muted.sfx],
        ["music", muted.music],
        true,
      ],
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
