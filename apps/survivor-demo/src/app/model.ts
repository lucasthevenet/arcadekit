import { AudioSettings } from "@gamekit/audio";
import { HudSample, RunSummary, UpgradeChoice } from "@gamekit/survivors";
import { Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

import { HeroRecords } from "./save";

// The UI's whole state. Note what is NOT here: enemies, projectiles, positions.
// Those live in the simulation. The UI only holds what it shows.
// HudSample, UpgradeChoice and RunSummary are the genre's Schemas for its event
// payloads, so a field the genre adds reaches the Model.

export const HeroSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  color: Schema.String,
});
export type HeroSummary = typeof HeroSummary.Type;

/** One player in a co-op lobby: its peer id and its hero ("" until it picks). */
export const CoopPlayer = Schema.Struct({
  id: Schema.String,
  heroId: Schema.String,
});
export type CoopPlayer = typeof CoopPlayer.Type;

export const Phase = defineTaggedUnion({
  Loading: {},
  LoadFailed: { error: Schema.String },
  Menu: {},
  Starting: {},
  Playing: {},
  Paused: {},
  LevelUp: { choices: Schema.Array(UpgradeChoice) },
  GameOver: { summary: RunSummary },

  // Co-op (#25): a lobby over the signalling worker, then a lockstep run.
  CoopMenu: { joinCode: Schema.String },
  CoopConnecting: {},
  CoopLobby: {
    role: Schema.Literals(["host", "guest"]),
    code: Schema.String,
    self: Schema.String,
    players: Schema.Array(CoopPlayer),
  },
  CoopPlaying: {},
  CoopLevelUp: { offer: Schema.Number, choices: Schema.Array(UpgradeChoice) },
  CoopGameOver: { summary: RunSummary },
  CoopFailed: { error: Schema.String },
});
export type Phase = typeof Phase.Type;

/** Whether `phase` is one of co-op's: the co-op client, not the single-player engine, draws then. */
export const isCoop = (phase: Phase): boolean => phase._tag.startsWith("Coop");

/** A co-op run as the UI shows it. */
export const CoopRun = Schema.Struct({
  /** The local player's hero. */
  slot: Schema.Number,
  /** Every player's name, by slot. */
  players: Schema.Array(Schema.String),
  /** The players stepping waits on ("waiting for X"). */
  waitingFor: Schema.Array(Schema.String),
  /** The other players with an upgrade to pick while the run is frozen. */
  choosing: Schema.Array(Schema.String),
  /** True while the local player holds the run paused. */
  paused: Schema.Boolean,
});
export type CoopRun = typeof CoopRun.Type;

export const emptyCoopRun: CoopRun = {
  slot: 0,
  players: [],
  waitingFor: [],
  choosing: [],
  paused: false,
};

export const Model = Schema.Struct({
  phase: Phase,
  heroes: Schema.Array(HeroSummary),
  selectedHeroId: Schema.String,
  /** The saved records, by hero id: read at startup, updated when each run ends. */
  records: HeroRecords,
  hud: HudSample,
  /** True while the viewport is in the document: the engine runs only then (see gameViewport). */
  isViewportMounted: Schema.Boolean,
  coop: CoopRun,
  /** The player's volumes and mute: read at startup, saved on each change. */
  audio: AudioSettings,
});
export type Model = typeof Model.Type;

export const emptyHud: HudSample = {
  level: 1,
  xp: 0,
  xpNext: 1,
  time: 0,
  runLength: 1,
  kills: 0,
  enemies: 0,
  heroes: [{ heroId: "", hp: 0, maxHp: 1, status: "playing", paused: false }],
};
