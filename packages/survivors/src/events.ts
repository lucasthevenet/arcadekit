import * as Game from "arcadekit/game";
import { Schema } from "effect";

// What a survivors run reports, and what its events carry. Each event is a class and its own
// Schema, and the payloads are Schemas too, so an app uses them in its Model and Messages, and a
// field added here reaches the app. A field is `Schema.Int` only where the step always produces
// a whole number (a slot, an offer number, a count, a level): time, HP and XP are fractional,
// and an event is checked when the step makes it.

/** One hero's part of the HUD. */
const HeroHud = Schema.Struct({
  heroId: Schema.String,
  hp: Schema.Number,
  maxHp: Schema.Number,
  status: Schema.Literals(["playing", "down", "left"]),
  /** True while this hero's player holds a co-op run paused. */
  paused: Schema.Boolean,
  /**
   * True while this hero has an upgrade offer open: the run waits on its player to pick. A
   * co-op app tells the others who from it ("waiting for X to pick").
   */
  choosing: Schema.Boolean,
});

/** One upgrade the player can pick. `LeveledUp` carries the choices on offer. */
export const UpgradeChoice = Schema.Struct({
  kind: Schema.Literals(["weapon", "passive", "heal"]),
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  /** Level the item reaches if picked. */
  level: Schema.Int,
});
export type UpgradeChoice = typeof UpgradeChoice.Type;

/** How the run ended for one hero: the team's time, kills and level, and that hero. `RunEnded` carries one per hero. */
export const RunSummary = Schema.Struct({
  won: Schema.Boolean,
  /** The id of the hero that was played. An unknown id falls back to the first hero, so this is the one actually played. */
  heroId: Schema.String,
  heroName: Schema.String,
  time: Schema.Number,
  kills: Schema.Int,
  level: Schema.Int,
});
export type RunSummary = typeof RunSummary.Type;

/**
 * The run's sample, which is what the HUD shows: the team's level and XP, the run, and each hero
 * by slot. Read when a run starts, every 100 ms, and right after the frame that ends the run.
 */
export class Hud extends Game.Event("Hud", {
  level: Schema.Int,
  xp: Schema.Number,
  xpNext: Schema.Number,
  time: Schema.Number,
  runLength: Schema.Number,
  kills: Schema.Int,
  enemies: Schema.Int,
  heroes: Schema.Array(HeroHud),
}) {}

/**
 * The team leveled up, and the hero in slot `hero` is offered `choices`, in the offer numbered
 * `offer`. One per playing hero. Its player answers with the `ChooseUpgrade` command, which
 * names `offer`.
 */
export class LeveledUp extends Game.Event("LeveledUp", {
  hero: Schema.Int,
  offer: Schema.Int,
  choices: Schema.Array(UpgradeChoice),
}) {}

/** The player of the hero in slot `hero` left the run. */
export class HeroLeft extends Game.Event("HeroLeft", {
  hero: Schema.Int,
}) {}

/** The run is over, won or lost: one summary per hero, by slot. */
export class RunEnded extends Game.Event("RunEnded", {
  summaries: Schema.Array(RunSummary),
}) {}
