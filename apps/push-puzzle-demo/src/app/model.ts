import { AudioSettings } from "@gamekit/audio";
import { HudSample } from "@gamekit/push-puzzle";
import { Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

import { LevelRecords } from "./save";

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
  /** `isNewBest` is true when the moves beat an earlier solve of this level. */
  Solved: { moves: Schema.Number, isNewBest: Schema.Boolean },
});
export type Phase = typeof Phase.Type;

/**
 * Whether the levels and the sprite sheet have loaded, so the engine exists: every phase but
 * `Loading` and `LoadFailed`. The engine entry attaches only then.
 */
export const isLoaded = (phase: Phase): boolean =>
  phase._tag !== "Loading" && phase._tag !== "LoadFailed";

export const Model = Schema.Struct({
  phase: Phase,
  levels: Schema.Array(LevelSummary),
  /** The saved records, by level id: read at startup, updated on each solve. */
  records: LevelRecords,
  /** The level being played, or last played. Restart and replay start it again. */
  levelId: Schema.String,
  hud: HudSample,
  /** The player's volume and mute: the defaults until the saved ones are read at startup. */
  audio: AudioSettings,
  /** True while the viewport is in the document: the engine runs only then (see gameViewport). */
  isViewportMounted: Schema.Boolean,
});
export type Model = typeof Model.Type;

export const emptyHud: HudSample = { moves: 0, boxesLeft: 0 };
