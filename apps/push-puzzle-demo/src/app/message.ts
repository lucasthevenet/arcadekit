import { Hud } from "@arcadekit/push-puzzle";
import { AudioSettings } from "arcadekit/audio";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import { LevelSummary } from "./model";
import { LevelRecords } from "./save";

// Every fact the UI can react to. Named for what happened, not what to do.
export const Message = defineMessageUnion({
  // Boot
  LoadedContent: { levels: Schema.Array(LevelSummary) },
  FailedToLoadContent: { error: Schema.String },
  ClickedRetry: {},
  LoadedSave: { records: LevelRecords },
  LoadedAudioSettings: { settings: AudioSettings.AudioSettings },
  MountedViewport: {},
  UnmountedViewport: {},

  // Level select
  ClickedLevel: { levelId: Schema.String },
  StartedRun: {},
  FailedToStartRun: { error: Schema.String },

  // From the engine
  GotHud: { hud: Hud },
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

  // Acknowledgements from fire-and-forget engine, audio and focus commands
  CompletedEngineCommand: {},
  CompletedAudioCommand: {},
  CompletedFocusCommand: {},
});
export type Message = typeof Message.Type;
