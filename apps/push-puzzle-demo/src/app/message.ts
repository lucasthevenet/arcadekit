import { HudSample } from "@gamekit/push-puzzle";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import { LevelSummary } from "./model";

// Every fact the UI can react to. Named for what happened, not what to do.
export const Message = defineMessageUnion({
  // Boot
  LoadedContent: { levels: Schema.Array(LevelSummary) },
  FailedToLoadContent: { error: Schema.String },
  MountedViewport: {},

  // Level select
  ClickedLevel: { levelId: Schema.String },
  StartedRun: {},
  FailedToStartRun: { error: Schema.String },

  // From the engine
  GotHud: { hud: HudSample },
  GotLevelSolved: { moves: Schema.Number },

  // In-run UI
  PressedRestart: {},
  PressedEscape: {},
  ClickedReplay: {},
  ClickedLevelSelect: {},

  // Acknowledgements from fire-and-forget engine commands
  CompletedEngineCommand: {},
});
export type Message = typeof Message.Type;
