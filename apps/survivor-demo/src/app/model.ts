import { Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

// The UI's whole state. Note what is NOT here: enemies, projectiles, positions.
// Those live in the simulation. The UI only holds what it shows.

export const HeroSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  color: Schema.String,
});
export type HeroSummary = typeof HeroSummary.Type;

export const Hud = Schema.Struct({
  hp: Schema.Number,
  maxHp: Schema.Number,
  level: Schema.Number,
  xp: Schema.Number,
  xpNext: Schema.Number,
  time: Schema.Number,
  runLength: Schema.Number,
  kills: Schema.Number,
  enemies: Schema.Number,
});
export type Hud = typeof Hud.Type;

export const UpgradeChoice = Schema.Struct({
  kind: Schema.Literals(["weapon", "passive", "heal"]),
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  level: Schema.Number,
});
export type UpgradeChoice = typeof UpgradeChoice.Type;

export const RunSummary = Schema.Struct({
  won: Schema.Boolean,
  heroName: Schema.String,
  time: Schema.Number,
  kills: Schema.Number,
  level: Schema.Number,
});
export type RunSummary = typeof RunSummary.Type;

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
  hud: Hud,
  /** True once the game's DOM element exists; the engine subscription waits for it. */
  isViewportMounted: Schema.Boolean,
});
export type Model = typeof Model.Type;

export const emptyHud: Hud = {
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
