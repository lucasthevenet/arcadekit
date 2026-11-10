import { Hud, RunSummary, UpgradeChoice } from "@arcadekit/survivors";
import { AudioSettings } from "arcadekit/audio";
import { Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

import { HeroRecords } from "./save";

// The UI's whole state. Note what is NOT here: enemies, projectiles, positions.
// Those live in the simulation. The UI only holds what it shows.
// Hud is the genre's own sample, which is also its Schema, and UpgradeChoice and
// RunSummary are its Schemas for what its events carry, so a field the genre adds
// reaches the Model.

export const HeroSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  color: Schema.String,
});
export type HeroSummary = typeof HeroSummary.Type;

/** One player in a co-op lobby: its peer id, its name, and its lobby pick, a hero id ("" until it picks). */
export const CoopPlayer = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  pick: Schema.String,
});
export type CoopPlayer = typeof CoopPlayer.Type;

export const Phase = defineTaggedUnion({
  Loading: {},
  LoadFailed: { error: Schema.String },
  Menu: {},
  Starting: {},
  Playing: {},
  Paused: {},
  /** `offer` is the number of the offer the choices are from: the pick names it. */
  LevelUp: { offer: Schema.Int, choices: Schema.Array(UpgradeChoice) },
  GameOver: { summary: RunSummary },

  // Co-op (#25): a lobby over the signalling worker, then a lockstep run.
  CoopMenu: { joinCode: Schema.String },
  CoopConnecting: {},
  CoopLobby: {
    role: Schema.Literals(["host", "guest"]),
    code: Schema.String,
    self: Schema.String,
    players: Schema.Array(CoopPlayer),
    /** The most players a run takes, and whether the host can start: the Co-op client's word. */
    maxPlayers: Schema.Number,
    canStart: Schema.Boolean,
  },
  CoopPlaying: {},
  /** `offer` is the number of the offer the choices are from: the pick names it. */
  CoopLevelUp: { offer: Schema.Int, choices: Schema.Array(UpgradeChoice) },
  CoopGameOver: { summary: RunSummary },
  CoopFailed: { error: Schema.String },
});
export type Phase = typeof Phase.Type;

/**
 * Whether the content and the sprite sheet have loaded, so a run can be played and drawn: every
 * phase but `Loading` and `LoadFailed`. The engine entries attach only then.
 */
export const isLoaded = (phase: Phase): boolean =>
  phase._tag !== "Loading" && phase._tag !== "LoadFailed";

/** Whether `phase` is one of co-op's: the co-op client, not the single-player engine, draws then. */
export const isCoop = (phase: Phase): boolean => phase._tag.startsWith("Coop");

/** A co-op run as the UI shows it. */
export const CoopRun = Schema.Struct({
  /** The local player's hero. */
  slot: Schema.Number,
  /** Every player's name, by slot. */
  names: Schema.Array(Schema.String),
  /** The players stepping waits on ("waiting for X"). */
  waitingFor: Schema.Array(Schema.String),
  /** The other players with an upgrade to pick while the run is frozen. */
  choosing: Schema.Array(Schema.String),
  /**
   * True while the local player has the run's menu up (Escape): the way to leave the run, and
   * the sound controls. It is the app's own, so it stays up whatever the run answers the pause
   * it asks for.
   */
  menu: Schema.Boolean,
  /**
   * True while the local player holds the run paused, as far as the app knows: set when the
   * menu opens for a hero that is playing, and cleared when the run doesn't take it (the hero
   * is down, or the run is over).
   */
  paused: Schema.Boolean,
});
export type CoopRun = typeof CoopRun.Type;

export const emptyCoopRun: CoopRun = {
  slot: 0,
  names: [],
  waitingFor: [],
  choosing: [],
  menu: false,
  paused: false,
};

export const Model = Schema.Struct({
  phase: Phase,
  heroes: Schema.Array(HeroSummary),
  selectedHeroId: Schema.String,
  /** The saved records, by hero id: read at startup, updated when each run ends. */
  records: HeroRecords,
  hud: Hud,
  /** True while the viewport is in the document: the engine runs only then (see gameViewport). */
  isViewportMounted: Schema.Boolean,
  coop: CoopRun,
  /** The player's volumes and mute: read at startup, saved on each change. */
  audio: AudioSettings,
});
export type Model = typeof Model.Type;

/**
 * Whether the local player's hero is out of a co-op run's play, by the HUD's last sample: it is
 * down. The rules take no pause from such a hero (`NotPlaying`), so the app asks for none. False
 * until the HUD has a sample of the hero.
 */
export const isLocalHeroDown = (model: Model): boolean => {
  const hero = model.hud.heroes[model.coop.slot];
  return hero !== undefined && hero.status !== "playing";
};

export const emptyHud = new Hud({
  level: 1,
  xp: 0,
  xpNext: 1,
  time: 0,
  runLength: 1,
  kills: 0,
  enemies: 0,
  heroes: [{ heroId: "", hp: 0, maxHp: 1, status: "playing", paused: false }],
});
