import { HudSample } from "@gamekit/push-puzzle";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import { LevelSummary } from "./model";
import { LevelRecords } from "./save";

// Every fact the UI can react to. Named for what happened, not what to do.
export const Message = defineMessageUnion({
  // Boot
  LoadedContent: { levels: Schema.Array(LevelSummary) },
  FailedToLoadContent: { error: Schema.String },
  LoadedSave: { records: LevelRecords },
  MountedViewport: {},
  UnmountedViewport: {},

  // Level select
  ClickedLevel: { levelId: Schema.String },
  StartedRun: {},
  FailedToStartRun: { error: Schema.String },

  // From the engine
  GotHud: { hud: HudSample },
  GotLevelSolved: { moves: Schema.Number },
  SavedSolve: { records: LevelRecords },

  // In-run UI
  PressedRestart: {},
  PressedEscape: {},
  ClickedReplay: {},
  ClickedLevelSelect: {},

  // Acknowledgements from fire-and-forget engine commands
  CompletedEngineCommand: {},
});
export type Message = typeof Message.Type;
