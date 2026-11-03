import type { SurvivorsContent } from "@gamekit/survivors";
import type { SurvivorsEngine } from "@gamekit/survivors/browser";
import type { Runtime, Update } from "foldkit";

import {
  ChooseUpgrade,
  EndRun,
  LoadContent,
  SetPaused,
  StartRun,
} from "./commands";
import { Message } from "./message";
import { Phase, emptyHud } from "./model";
import type { Model } from "./model";

export type Services = SurvivorsContent | SurvivorsEngine;
type Return = Update.Return<Model, Message, Services>;

export const init: Runtime.ApplicationInit<
  Model,
  Message,
  void,
  Services
> = () => ({
  model: {
    phase: Phase.Loading(),
    heroes: [],
    selectedHeroId: "",
    hud: emptyHud,
    isViewportMounted: false,
  },
  commands: [LoadContent()],
});

const startRun = (model: Model): Return => ({
  model: { ...model, phase: Phase.Starting() },
  commands: [StartRun({ heroId: model.selectedHeroId })],
});

const backToMenu = (model: Model): Return => ({
  model: { ...model, phase: Phase.Menu() },
  commands: [EndRun()],
});

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    LoadedContent: ({ heroes }) => ({
      model: {
        ...model,
        heroes,
        selectedHeroId: heroes[0]?.id ?? "",
        phase: Phase.Menu(),
      },
    }),
    FailedToLoadContent: ({ error }) => ({
      model: { ...model, phase: Phase.LoadFailed({ error }) },
    }),
    MountedViewport: () => ({ model: { ...model, isViewportMounted: true } }),
    UnmountedViewport: () => ({
      model: { ...model, isViewportMounted: false },
    }),

    SelectedHero: ({ heroId }) => ({
      model: { ...model, selectedHeroId: heroId },
    }),
    ClickedStart: () =>
      model.phase._tag === "Menu" ? startRun(model) : { model },
    StartedRun: () => ({ model: { ...model, phase: Phase.Playing() } }),
    FailedToStartRun: ({ error }) => ({
      model: { ...model, phase: Phase.LoadFailed({ error }) },
    }),

    GotHud: ({ hud }) => ({ model: { ...model, hud } }),
    GotLevelUp: ({ choices }) => ({
      model: { ...model, phase: Phase.LevelUp({ choices }) },
    }),
    GotRunEnded: ({ summary }) => ({
      model: { ...model, phase: Phase.GameOver({ summary }) },
    }),

    ClickedUpgrade: ({ index }) =>
      model.phase._tag === "LevelUp"
        ? {
            model: { ...model, phase: Phase.Playing() },
            commands: [ChooseUpgrade({ index })],
          }
        : { model },
    PressedEscape: () => {
      if (model.phase._tag === "Playing") {
        return {
          model: { ...model, phase: Phase.Paused() },
          commands: [SetPaused({ paused: true })],
        };
      }
      if (model.phase._tag === "Paused") {
        return {
          model: { ...model, phase: Phase.Playing() },
          commands: [SetPaused({ paused: false })],
        };
      }
      return { model };
    },
    ClickedResume: () => ({
      model: { ...model, phase: Phase.Playing() },
      commands: [SetPaused({ paused: false })],
    }),
    ClickedQuit: () => backToMenu(model),
    ClickedPlayAgain: () => startRun(model),

    CompletedEngineCommand: () => ({ model }),
  });
