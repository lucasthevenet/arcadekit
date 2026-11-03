import { Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

// The UI's whole state. The board isn't here: it lives in the simulation.
// The UI only holds what it shows.

export const LevelSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});
export type LevelSummary = typeof LevelSummary.Type;

export const Hud = Schema.Struct({
  moves: Schema.Number,
  boxesLeft: Schema.Number,
});
export type Hud = typeof Hud.Type;

export const Phase = defineTaggedUnion({
  Loading: {},
  LoadFailed: { error: Schema.String },
  LevelSelect: {},
  Starting: {},
  Playing: {},
  Solved: { moves: Schema.Number },
});
export type Phase = typeof Phase.Type;

export const Model = Schema.Struct({
  phase: Phase,
  levels: Schema.Array(LevelSummary),
  /** The level being played, or last played. Restart and replay start it again. */
  levelId: Schema.String,
  hud: Hud,
  /** True once the game's DOM element exists; the engine subscription waits for it. */
  isViewportMounted: Schema.Boolean,
});
export type Model = typeof Model.Type;

export const emptyHud: Hud = { moves: 0, boxesLeft: 0 };
