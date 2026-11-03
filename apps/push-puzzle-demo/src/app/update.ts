import type { PushPuzzleContent } from "@gamekit/push-puzzle";
import type { PushPuzzleEngine } from "@gamekit/push-puzzle/browser";
import type { Runtime, Update } from "foldkit";

import { EndRun, LoadContent, StartLevel } from "./commands";
import { Message } from "./message";
import { Phase, emptyHud } from "./model";
import type { Model } from "./model";

export type Services = PushPuzzleContent | PushPuzzleEngine;
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
    levelId: "",
    hud: emptyHud,
    isViewportMounted: false,
  },
  commands: [LoadContent()],
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
      model: { ...model, phase: Phase.Solved({ moves }) },
    }),

    PressedRestart: () => startLevel(model, model.levelId),
    PressedEscape: () => backToLevelSelect(model),
    ClickedReplay: () => startLevel(model, model.levelId),
    ClickedLevelSelect: () => backToLevelSelect(model),

    CompletedEngineCommand: () => ({ model }),
  });
