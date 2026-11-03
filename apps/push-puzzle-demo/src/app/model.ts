import { HudSample } from "@gamekit/push-puzzle";
import { Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

// The UI's whole state. The board isn't here: it lives in the simulation.
// The UI only holds what it shows.
// HudSample is the genre's Schema for its hud event's payload, so a field the
// genre adds reaches the Model.

export const LevelSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});
export type LevelSummary = typeof LevelSummary.Type;

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
  hud: HudSample,
  /** True while the viewport is in the document: the engine runs only then (see gameViewport). */
  isViewportMounted: Schema.Boolean,
});
export type Model = typeof Model.Type;

export const emptyHud: HudSample = { moves: 0, boxesLeft: 0 };
