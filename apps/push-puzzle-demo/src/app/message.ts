import { AudioSettings } from "arcadekit/audio";
import type { AudioSystem } from "arcadekit/audio";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

/**
 * The app's Messages: Foldkit's contract. The engine's events reach the app as Messages
 * (`GotHud`, `GotLevelSolved`), so a Message is not an event.
 *
 * Plain on purpose: a Schema, which `update` matches on (Foldkit's contract).
 */
import { Hud } from "#push-puzzle";

import * as LevelRecords from "./level-records";
import { LevelSummary } from "./model";

/** Every fact the UI can react to, named for what happened, not what to do. */
export const Message = defineMessageUnion({
  // Boot
  LoadedContent: { levels: Schema.Array(LevelSummary) },
  FailedToLoadContent: { error: Schema.String },
  ClickedRetry: {},
  LoadedSave: { records: LevelRecords.LevelRecords },
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
  SavedSolve: { records: LevelRecords.LevelRecords },

  // In-run UI
  PressedRestart: {},
  PressedEscape: {},
  ClickedReplay: {},
  ClickedLevelSelect: {},

  // Sound panel and the M key, on any screen
  ChangedVolume: {
    // The kit's `AudioSystem.Bus` is a type with no Schema: `satisfies` ties these to it.
    bus: Schema.Literals([
      "master",
      "sfx",
      "music",
    ] as const satisfies readonly AudioSystem.Bus[]),
    volume: Schema.Number,
  },
  ToggledMute: {},
  PressedMuteKey: {},

  // Acknowledgements from fire-and-forget engine, audio and focus commands
  CompletedEngineCommand: {},
  CompletedAudioCommand: {},
  CompletedFocusCommand: {},
});
/** One fact the UI reacts to, decoded. */
export type Message = typeof Message.Type;
