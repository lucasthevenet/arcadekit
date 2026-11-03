import { Schema } from "effect";

// The events a push-puzzle run reports, and their payloads.
// HudSample is an Effect Schema, declared once here. An app uses it in its Model
// and Messages, so a field added here reaches the app's Model.

/** What the HUD shows. The hud event carries it. */
export const HudSample = Schema.Struct({
  moves: Schema.Number,
  /** Goals that have no box on them yet. */
  boxesLeft: Schema.Number,
});
export type HudSample = typeof HudSample.Type;

/** What a push-puzzle run reports to the outside. */
export type PushPuzzleEvent =
  | { readonly type: "hud"; readonly hud: HudSample }
  | { readonly type: "levelSolved"; readonly moves: number };
