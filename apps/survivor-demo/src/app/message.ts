import { AudioSettings } from "arcadekit/audio";
import type { AudioSystem } from "arcadekit/audio";
import { CoopEvent } from "arcadekit/net/browser";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

/**
 * The app's Messages: Foldkit's contract. The engine's and the Co-op client's events reach the
 * app as Messages (`GotHud`, `GotCoopLobby`), so a Message is not an event.
 *
 * Plain on purpose: a Schema, which `update` matches on (Foldkit's contract).
 */
import { Hero, Hud, Offer } from "#survivors";

import * as HeroRecords from "./hero-records";
import { HeroListing } from "./model";

/** Every fact the UI can react to, named for what happened, not what to do. */
export const Message = defineMessageUnion({
  // Boot
  LoadedContent: { heroes: Schema.Array(HeroListing) },
  FailedToLoadContent: { error: Schema.String },
  ClickedRetry: {},
  LoadedSave: { records: HeroRecords.HeroRecords },
  MountedViewport: {},
  UnmountedViewport: {},

  // Menu
  SelectedHero: { heroId: Schema.String },
  ClickedStart: {},
  StartedRun: {},
  FailedToStartRun: { error: Schema.String },

  // From the engine
  GotHud: { hud: Hud },
  GotLevelUp: { offer: Schema.Int, choices: Schema.Array(Offer.Choice) },
  GotRunEnded: { summary: Hero.Summary },
  SavedRun: { records: HeroRecords.HeroRecords },

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
  /** The Co-op client's own event, as it reports it: who is in the lobby, and whether it can start. */
  GotCoopLobby: { lobby: CoopEvent.LobbyChanged },
  GotCoopStarted: { slot: Schema.Int, names: Schema.Array(Schema.String) },
  GotCoopWaiting: { waitingFor: Schema.Array(Schema.String) },
  GotCoopLevelUp: {
    offer: Schema.Int,
    choices: Schema.Array(Offer.Choice),
  },
  GotCoopRunEnded: { summary: Hero.Summary },
  GotCoopFailed: { error: Schema.String },

  // Sound: the saved settings, the sound panel and the M key
  LoadedAudioSettings: { settings: AudioSettings.AudioSettings },
  ChangedVolume: {
    // The kit's `AudioSystem.Bus` is a type with no Schema: `satisfies` ties these to it.
    bus: Schema.Literals([
      "master",
      "sfx",
      "music",
    ] as const satisfies readonly AudioSystem.Bus[]),
    volume: Schema.Number,
  },
  ClickedMute: {},
  PressedMute: {},

  // Acknowledgements from fire-and-forget engine, co-op, audio and focus commands
  CompletedEngineCommand: {},
  CompletedAudioCommand: {},
  CompletedFocusCommand: {},
});
/** One fact the UI reacts to, decoded. */
export type Message = typeof Message.Type;
