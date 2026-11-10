import { Hud, RunSummary, UpgradeChoice } from "@arcadekit/survivors";
import { AudioSettings } from "arcadekit/audio";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import { CoopPlayer, HeroSummary } from "./model";
import { HeroRecords } from "./save";

// Every fact the UI can react to. Named for what happened, not what to do.
export const Message = defineMessageUnion({
  // Boot
  LoadedContent: { heroes: Schema.Array(HeroSummary) },
  FailedToLoadContent: { error: Schema.String },
  ClickedRetry: {},
  LoadedSave: { records: HeroRecords },
  MountedViewport: {},
  UnmountedViewport: {},

  // Menu
  SelectedHero: { heroId: Schema.String },
  ClickedStart: {},
  StartedRun: {},
  FailedToStartRun: { error: Schema.String },

  // From the engine
  GotHud: { hud: Hud },
  GotLevelUp: { offer: Schema.Int, choices: Schema.Array(UpgradeChoice) },
  GotRunEnded: { summary: RunSummary },
  SavedRun: { records: HeroRecords },

  // In-run UI
  ClickedUpgrade: { index: Schema.Int },
  PressedEscape: {},
  ClickedResume: {},
  ClickedQuit: {},
  ClickedPlayAgain: {},

  // Co-op
  ClickedCoop: {},
  ClickedHostCoop: {},
  ChangedJoinCode: { code: Schema.String },
  ClickedJoinCoop: {},
  ClickedStartCoop: {},
  ClickedCoopUpgrade: { index: Schema.Int },
  ClickedCoopResume: {},
  ClickedLeaveCoop: {},
  /** The run didn't take the local player's pause, or its letting go: it holds none. */
  FailedToHoldCoopPause: {},
  GotCoopLobby: {
    role: Schema.Literals(["host", "guest"]),
    code: Schema.String,
    self: Schema.String,
    players: Schema.Array(CoopPlayer),
    maxPlayers: Schema.Number,
    canStart: Schema.Boolean,
  },
  GotCoopStarted: { slot: Schema.Number, names: Schema.Array(Schema.String) },
  GotCoopWaiting: {
    waitingFor: Schema.Array(Schema.String),
    choosing: Schema.Array(Schema.String),
  },
  GotCoopLevelUp: {
    offer: Schema.Int,
    choices: Schema.Array(UpgradeChoice),
  },
  GotCoopRunEnded: { summary: RunSummary },
  GotCoopFailed: { error: Schema.String },

  // Sound
  LoadedAudioSettings: { settings: AudioSettings },
  ChangedVolume: {
    bus: Schema.Literals(["master", "sfx", "music"]),
    volume: Schema.Number,
  },
  ClickedMute: {},
  PressedMute: {},

  // Acknowledgements from fire-and-forget engine, audio and focus commands
  CompletedEngineCommand: {},
  CompletedAudioCommand: {},
  CompletedFocusCommand: {},
});
export type Message = typeof Message.Type;
