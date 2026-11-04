import { AudioSettings } from "@gamekit/audio";
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
  LoadedAudioSettings: { settings: AudioSettings },
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

  // Sound panel and the M key, on any screen
  ChangedVolume: {
    bus: Schema.Literals(["master", "sfx", "music"]),
    volume: Schema.Number,
  },
  ToggledMute: {},
  PressedMuteKey: {},

  // Acknowledgements from fire-and-forget engine and audio commands
  CompletedEngineCommand: {},
  CompletedAudioCommand: {},
});
export type Message = typeof Message.Type;
