import { Schema } from "effect";

// The events a survivors run reports, and their payloads.
// The payloads are Effect Schemas, declared once here. An app uses these Schemas
// in its Model and Messages, so a field added here reaches the app's Model.

/** One hero's part of the HUD. */
const HeroHud = Schema.Struct({
  heroId: Schema.String,
  hp: Schema.Number,
  maxHp: Schema.Number,
  status: Schema.Literals(["playing", "down", "left"]),
  /** True while this hero's player holds a co-op run paused. */
  paused: Schema.Boolean,
});

/** What the HUD shows: the team's level and XP, the run, and each hero by slot. The hud event carries it. */
export const HudSample = Schema.Struct({
  level: Schema.Number,
  xp: Schema.Number,
  xpNext: Schema.Number,
  time: Schema.Number,
  runLength: Schema.Number,
  kills: Schema.Number,
  enemies: Schema.Number,
  heroes: Schema.Array(HeroHud),
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

/** How the run ended for one hero: the team's time, kills and level, and that hero. The runEnded event carries one per hero. */
export const RunSummary = Schema.Struct({
  won: Schema.Boolean,
  /** The id of the hero that was played. An unknown id falls back to the first hero, so this is the one actually played. */
  heroId: Schema.String,
  heroName: Schema.String,
  time: Schema.Number,
  kills: Schema.Number,
  level: Schema.Number,
});
export type RunSummary = typeof RunSummary.Type;

/**
 * What a survivors run reports to the outside. `hero` is a hero's slot (its player's place in
 * player order).
 *
 * - `levelUp`: the team leveled up and `hero` is offered `choices`, in the offer numbered `offer`
 *   (pick it with `chooseUpgrade` or a step input's `pick`). One per playing hero.
 * - `heroLeft`: `hero`'s player left the run.
 * - `runEnded`: one summary per hero, by slot.
 */
export type SurvivorsEvent =
  | { readonly type: "hud"; readonly hud: HudSample }
  | {
      readonly type: "levelUp";
      readonly hero: number;
      readonly offer: number;
      readonly choices: readonly UpgradeChoice[];
    }
  | { readonly type: "heroLeft"; readonly hero: number }
  | { readonly type: "runEnded"; readonly summaries: readonly RunSummary[] };
