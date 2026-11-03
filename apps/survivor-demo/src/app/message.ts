import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import { HeroSummary, Hud, RunSummary, UpgradeChoice } from "./model";

// Every fact the UI can react to. Named for what happened, not what to do.
export const Message = defineMessageUnion({
  // Boot
  LoadedContent: { heroes: Schema.Array(HeroSummary) },
  FailedToLoadContent: { error: Schema.String },
  MountedViewport: {},

  // Menu
  SelectedHero: { heroId: Schema.String },
  ClickedStart: {},
  StartedRun: {},
  FailedToStartRun: { error: Schema.String },

  // From the engine
  GotHud: { hud: Hud },
  GotLevelUp: { choices: Schema.Array(UpgradeChoice) },
  GotRunEnded: { summary: RunSummary },

  // In-run UI
  ClickedUpgrade: { index: Schema.Number },
  PressedEscape: {},
  ClickedResume: {},
  ClickedQuit: {},
  ClickedPlayAgain: {},

  // Acknowledgements from fire-and-forget engine commands
  CompletedEngineCommand: {},
});
export type Message = typeof Message.Type;
