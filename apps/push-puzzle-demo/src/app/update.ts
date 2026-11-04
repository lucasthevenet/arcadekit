import type { PushPuzzleContent } from "@gamekit/push-puzzle";
import type { PushPuzzleEngine } from "@gamekit/push-puzzle/browser";
import type { Runtime, Update } from "foldkit";

import {
  EndRun,
  LoadContent,
  LoadSave,
  SaveSolve,
  StartLevel,
} from "./commands";
import { Message } from "./message";
import { Phase, emptyHud } from "./model";
import type { Model } from "./model";
import { emptyRecords, isNewBest, mergeRecords, withSolve } from "./save";
import type { Save } from "./save";

export type Services = PushPuzzleContent | PushPuzzleEngine | Save;
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
    isViewportMounted: false,
  },
  commands: [LoadContent(), LoadSave()],
});

const startLevel = (model: Model, levelId: string): Return => ({
  model: { ...model, levelId, hud: emptyHud, phase: Phase.Starting() },
  commands: [StartLevel({ levelId })],
});

const backToLevelSelect = (model: Model): Return => ({
  model: { ...model, phase: Phase.LevelSelect() },
  commands: [EndRun()],
});

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    LoadedContent: ({ levels }) => ({
      model: { ...model, levels, phase: Phase.LevelSelect() },
    }),
    FailedToLoadContent: ({ error }) => ({
      model: { ...model, phase: Phase.LoadFailed({ error }) },
    }),
    LoadedSave: ({ records }) => ({
      model: { ...model, records: mergeRecords(model.records, records) },
    }),
    MountedViewport: () => ({ model: { ...model, isViewportMounted: true } }),
    UnmountedViewport: () => ({
      model: { ...model, isViewportMounted: false },
    }),

    ClickedLevel: ({ levelId }) =>
      model.phase._tag === "LevelSelect"
        ? startLevel(model, levelId)
        : { model },
    StartedRun: () => ({ model: { ...model, phase: Phase.Playing() } }),
    FailedToStartRun: ({ error }) => ({
      model: { ...model, phase: Phase.LoadFailed({ error }) },
    }),

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
    ClickedReplay: () => startLevel(model, model.levelId),
    ClickedLevelSelect: () => backToLevelSelect(model),

    CompletedEngineCommand: () => ({ model }),
  });
