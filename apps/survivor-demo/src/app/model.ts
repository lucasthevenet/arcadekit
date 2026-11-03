import { HudSample, RunSummary, UpgradeChoice } from "@gamekit/survivors";
import { Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

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

export const Phase = defineTaggedUnion({
  Loading: {},
  LoadFailed: { error: Schema.String },
  Menu: {},
  Starting: {},
  Playing: {},
  Paused: {},
  LevelUp: { choices: Schema.Array(UpgradeChoice) },
  GameOver: { summary: RunSummary },
});
export type Phase = typeof Phase.Type;

export const Model = Schema.Struct({
  phase: Phase,
  heroes: Schema.Array(HeroSummary),
  selectedHeroId: Schema.String,
  hud: HudSample,
  /** True while the viewport is in the document: the engine runs only then (see gameViewport). */
  isViewportMounted: Schema.Boolean,
});
export type Model = typeof Model.Type;

export const emptyHud: HudSample = {
  hp: 0,
  maxHp: 1,
  level: 1,
  xp: 0,
  xpNext: 1,
  time: 0,
  runLength: 1,
  kills: 0,
  enemies: 0,
};
