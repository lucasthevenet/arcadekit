import type { PushPuzzleContent } from "@arcadekit/push-puzzle";
import type {
  PushPuzzleEngine,
  PushPuzzleSheet,
} from "@arcadekit/push-puzzle/browser";
import { defaultAudioSettings } from "arcadekit/audio";
import type { Audio, AudioSettings } from "arcadekit/audio";
import type { Runtime, Update } from "foldkit";

import { withVolume } from "./audio";
import type { AudioSettingsStorage } from "./audio";
import {
  ChangeAudioSettings,
  EndRun,
  FocusRetry,
  LoadAudioSettings,
  LoadContent,
  LoadSave,
  LoadSounds,
  PlayClick,
  SaveSolve,
  StartLevel,
} from "./commands";
import { Message } from "./message";
import { Phase, emptyHud } from "./model";
import type { Model } from "./model";
import { emptyRecords, isNewBest, mergeRecords, withSolve } from "./save";
import type { Save } from "./save";

export type Services =
  | Audio
  | AudioSettingsStorage
  | PushPuzzleContent
  | PushPuzzleEngine
  | PushPuzzleSheet
  | Save;
type Return = Update.Return<Model, Message, Services>;

export const init: Runtime.ApplicationInit<
  Model,
  Message,
  void,
  Services
> = () => ({
  model: {
    phase: Phase.Loading(),
    levels: [],
    records: emptyRecords,
    levelId: "",
    hud: emptyHud,
    audio: defaultAudioSettings,
    isViewportMounted: false,
  },
  commands: [LoadContent(), LoadSave(), LoadAudioSettings(), LoadSounds()],
});

/** The load-error screen, with its "Try again" focused. */
const loadFailed = (model: Model, error: string): Return => ({
  model: { ...model, phase: Phase.LoadFailed({ error }) },
  commands: [FocusRetry()],
});

const startLevel = (model: Model, levelId: string): Return => ({
  model: { ...model, levelId, hud: emptyHud, phase: Phase.Starting() },
  commands: [StartLevel({ levelId })],
});

const backToLevelSelect = (model: Model): Return => ({
  model: { ...model, phase: Phase.LevelSelect() },
  commands: [EndRun()],
});

/** A menu button's click, on top of what the button does. */
const withClick = ({ model, commands = [] }: Return): Return => ({
  model,
  commands: [...commands, PlayClick()],
});

const changeAudio = (model: Model, audio: AudioSettings): Return => ({
  model: { ...model, audio },
  commands: [ChangeAudioSettings({ settings: audio })],
});

const toggleMute = (model: Model): Return =>
  changeAudio(model, { ...model.audio, muted: !model.audio.muted });

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    LoadedContent: ({ levels }) => ({
      model: { ...model, levels, phase: Phase.LevelSelect() },
    }),
    FailedToLoadContent: ({ error }) => loadFailed(model, error),
    // Loads again, then goes to level select as on a first load. Each loader keeps its first
    // success, so only what failed is fetched again.
    ClickedRetry: () =>
      model.phase._tag === "LoadFailed"
        ? withClick({
            model: { ...model, phase: Phase.Loading() },
            commands: [LoadContent()],
          })
        : { model },
    LoadedSave: ({ records }) => ({
      model: { ...model, records: mergeRecords(model.records, records) },
    }),
    LoadedAudioSettings: ({ settings }) => ({
      model: { ...model, audio: settings },
    }),
    MountedViewport: () => ({ model: { ...model, isViewportMounted: true } }),
    UnmountedViewport: () => ({
      model: { ...model, isViewportMounted: false },
    }),

    ClickedLevel: ({ levelId }) =>
      model.phase._tag === "LevelSelect"
        ? withClick(startLevel(model, levelId))
        : { model },
    StartedRun: () => ({ model: { ...model, phase: Phase.Playing() } }),
    FailedToStartRun: ({ error }) => loadFailed(model, error),

    GotHud: ({ hud }) => ({ model: { ...model, hud } }),
    GotLevelSolved: ({ moves }) => ({
      model: {
        ...model,
        phase: Phase.Solved({
          moves,
          isNewBest: isNewBest(model.records, model.levelId, moves),
        }),
        records: withSolve(model.records, model.levelId, moves),
      },
      commands: [SaveSolve({ levelId: model.levelId, moves })],
    }),
    SavedSolve: ({ records }) => ({
      model: { ...model, records: mergeRecords(model.records, records) },
    }),

    PressedRestart: () => startLevel(model, model.levelId),
    PressedEscape: () => backToLevelSelect(model),
    ClickedReplay: () => withClick(startLevel(model, model.levelId)),
    ClickedLevelSelect: () => withClick(backToLevelSelect(model)),

    ChangedVolume: ({ bus, volume }) =>
      changeAudio(model, withVolume(model.audio, bus, volume)),
    ToggledMute: () => toggleMute(model),
    PressedMuteKey: () => toggleMute(model),

    CompletedEngineCommand: () => ({ model }),
    CompletedAudioCommand: () => ({ model }),
    CompletedFocusCommand: () => ({ model }),
  });
