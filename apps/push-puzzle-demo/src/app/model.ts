/**
 * The app's Model: Foldkit's contract, with the Schemas it is made of.
 *
 * Plain on purpose: Schemas, which `update` and `view` read, and `isLoaded`, a pure function the
 * engine entry reads (Foldkit's contract).
 */
import { AudioSettings } from "arcadekit/audio";
import { Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

import { Hud } from "#push-puzzle";

import * as LevelRecords from "./level-records";

/** A level as level select lists it: its id and its name. */
export const LevelSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});
/** A level as level select lists it, decoded. */
export type LevelSummary = typeof LevelSummary.Type;

/** Which screen the app is on, from loading to a level solved. */
export const Phase = defineTaggedUnion({
  Loading: {},
  LoadFailed: { error: Schema.String },
  LevelSelect: {},
  Starting: {},
  Playing: {},
  /** `isNewBest` is true when the moves beat an earlier solve of this level. */
  Solved: { moves: Schema.Number, isNewBest: Schema.Boolean },
});
/** Which screen the app is on, decoded. */
export type Phase = typeof Phase.Type;

/**
 * Whether the levels and the sprite sheet have loaded, so the engine can attach: every phase but
 * `Loading` and `LoadFailed`. The engine entry attaches only then.
 */
export const isLoaded = (phase: Phase): boolean =>
  phase._tag !== "Loading" && phase._tag !== "LoadFailed";

/**
 * The UI's whole state: what it shows. The board isn't here: it lives in the run, which the
 * engine draws. `hud` is the genre's own sample, which is also its Schema, so a field the genre
 * adds reaches the Model.
 */
export const Model = Schema.Struct({
  phase: Phase,
  levels: Schema.Array(LevelSummary),
  /** The saved records, by level id: read at startup, updated on each solve. */
  records: LevelRecords.LevelRecords,
  /** The level being played, or last played. Restart and replay start it again. */
  levelId: Schema.String,
  hud: Hud,
  /** The player's volume and mute: the defaults until the saved ones are read at startup. */
  audio: AudioSettings.AudioSettings,
  /** True while the viewport is in the document: the engine runs only then (see Viewport.make). */
  isViewportMounted: Schema.Boolean,
});
/** The UI's whole state, decoded. */
export type Model = typeof Model.Type;

/** The HUD before a run's first sample: no moves, no box to place. */
export const emptyHud = new Hud({ moves: 0, boxesLeft: 0 });
