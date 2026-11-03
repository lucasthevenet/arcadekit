import { Schema } from "effect";

// The events a survivors run reports, and their payloads.
// The payloads are Effect Schemas, declared once here. An app uses these Schemas
// in its Model and Messages, so a field added here reaches the app's Model.

/** What the HUD shows. The hud event carries it. */
export const HudSample = Schema.Struct({
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
export type HudSample = typeof HudSample.Type;

/** One upgrade the player can pick. The levelUp event carries the choices on offer. */
export const UpgradeChoice = Schema.Struct({
  kind: Schema.Literals(["weapon", "passive", "heal"]),
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  /** Level the item reaches if picked. */
  level: Schema.Number,
});
export type UpgradeChoice = typeof UpgradeChoice.Type;

/** How the run ended. The runEnded event carries it. */
export const RunSummary = Schema.Struct({
  won: Schema.Boolean,
  heroName: Schema.String,
  time: Schema.Number,
  kills: Schema.Number,
  level: Schema.Number,
});
export type RunSummary = typeof RunSummary.Type;

/** What a survivors run reports to the outside. */
export type SurvivorsEvent =
  | { readonly type: "hud"; readonly hud: HudSample }
  | { readonly type: "levelUp"; readonly choices: readonly UpgradeChoice[] }
  | { readonly type: "runEnded"; readonly summary: RunSummary };
