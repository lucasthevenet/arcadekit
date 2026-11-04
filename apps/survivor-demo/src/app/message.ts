import { AudioSettings } from "@gamekit/audio";
import { HudSample, RunSummary, UpgradeChoice } from "@gamekit/survivors";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import { CoopPlayer, HeroSummary } from "./model";
import { HeroRecords } from "./save";

// Every fact the UI can react to. Named for what happened, not what to do.
export const Message = defineMessageUnion({
  // Boot
  LoadedContent: { heroes: Schema.Array(HeroSummary) },
  FailedToLoadContent: { error: Schema.String },
  LoadedSave: { records: HeroRecords },
  MountedViewport: {},
  UnmountedViewport: {},

  // Menu
  SelectedHero: { heroId: Schema.String },
  ClickedStart: {},
  StartedRun: {},
  FailedToStartRun: { error: Schema.String },

  // From the engine
  GotHud: { hud: HudSample },
  GotLevelUp: { choices: Schema.Array(UpgradeChoice) },
  GotRunEnded: { summary: RunSummary },
  SavedRun: { records: HeroRecords },

  // In-run UI
  ClickedUpgrade: { index: Schema.Number },
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
  ClickedCoopUpgrade: { index: Schema.Number },
  ClickedCoopResume: {},
  ClickedLeaveCoop: {},
  GotCoopLobby: {
    role: Schema.Literals(["host", "guest"]),
    code: Schema.String,
    self: Schema.String,
    players: Schema.Array(CoopPlayer),
  },
  GotCoopStarted: { slot: Schema.Number, players: Schema.Array(Schema.String) },
  GotCoopWaiting: {
    waitingFor: Schema.Array(Schema.String),
    choosing: Schema.Array(Schema.String),
  },
  GotCoopLevelUp: {
    offer: Schema.Number,
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

  // Acknowledgements from fire-and-forget engine and audio commands
  CompletedEngineCommand: {},
  CompletedAudioCommand: {},
});
export type Message = typeof Message.Type;
