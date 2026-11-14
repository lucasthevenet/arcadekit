/**
 * Survivors' events: what a run reports to the app.
 *
 * Each is a declaration: a class that is also its own Schema, so an app uses it in its Model and
 * its Messages, and a field added here reaches the app. A run reports `LeveledUp`, `HeroLeft`
 * and `RunEnded` from its step, and `Hud` is its sample. A field is `Schema.Int` only where the
 * step always makes a whole number (a slot, an offer's number, a count, a level): time, hit points
 * and XP are fractional, and an event is checked when the step makes it.
 */
import * as Game from "arcadekit/game";
import { Schema } from "effect";

import * as Hero from "./hero";
import * as Offer from "./offer";

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

/**
 * What the HUD shows: the team's level and XP, the run's time and length, the kills, the enemies
 * alive, and each hero by slot. It is the run's sample.
 *
 * **When to use**
 *
 * In an app's Model and Messages, to show the HUD: the engine reports it, and `Survivors.match`
 * turns it into a Message (`SurvivorsCoop.match` in co-op). A co-op app names who the run waits
 * on from each hero's `choosing` and `paused`.
 *
 * **Details**
 *
 * It is read when a run starts, every 100 ms, and right after the frame that ends the run, so the
 * HUD shows the run's last numbers.
 *
 * **Example** (A HUD for one hero, choosing)
 *
 * ```ts
 * import { Hud } from "@arcadekit/survivors";
 *
 * const hud = new Hud({
 *   level: 3,
 *   xp: 2,
 *   xpNext: 9,
 *   time: 61.5,
 *   runLength: 600,
 *   kills: 40,
 *   enemies: 25,
 *   heroes: [{ heroId: "bolter", hp: 80, maxHp: 100, status: "playing", paused: false, choosing: true }],
 * });
 * hud.heroes.filter((hero) => hero.choosing).length; // => 1
 * ```
 *
 * @category declarations
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
 * `offer`. A run reports one for each playing hero.
 *
 * **When to use**
 *
 * In an app's Messages, to show the local player's choices: its player answers with the
 * `ChooseUpgrade` command, which names `offer`.
 *
 * **Details**
 *
 * It is reported at the end of a step, and the run is frozen from the next step until every
 * hero's offer is closed. Its `choices` are a copy: the event shares nothing with the run's
 * state.
 *
 * **Example** (An offer for the first hero)
 *
 * ```ts
 * import { LeveledUp } from "@arcadekit/survivors";
 *
 * const leveled = new LeveledUp({
 *   hero: 0,
 *   offer: 1,
 *   choices: [{ kind: "weapon", id: "bolt", name: "Bolt", description: "", level: 2 }],
 * });
 * [leveled.offer, leveled.choices.length]; // => [1, 1]
 * ```
 *
 * @category declarations
 */
export class LeveledUp extends Game.Event("LeveledUp", {
  hero: Schema.Int,
  offer: Schema.Int,
  choices: Schema.Array(Offer.Choice),
}) {}

/**
 * The player of the hero in slot `hero` left the run.
 *
 * **When to use**
 *
 * In a co-op app's Messages, to say who left. The run goes on without that hero, and the view no
 * longer draws it.
 *
 * **Details**
 *
 * A run reports it at the step whose input lists the slot in `leaving`, once per hero. The hero's
 * open offer closes with it.
 *
 * **Example** (The second player left)
 *
 * ```ts
 * import { HeroLeft } from "@arcadekit/survivors";
 *
 * new HeroLeft({ hero: 1 }).hero; // => 1
 * ```
 *
 * @category declarations
 */
export class HeroLeft extends Game.Event("HeroLeft", {
  hero: Schema.Int,
}) {}

/**
 * The run is over, won or lost, with one summary for each hero, by slot.
 *
 * **When to use**
 *
 * In an app's Messages, to show the end screen and save each hero's run: a single-player app reads
 * slot 0, and a co-op app its local player's.
 *
 * **Details**
 *
 * A run is lost once no hero is playing, and won when its time reaches the rules' `runLength`
 * with a hero still playing. It is reported once per run, and the run's steps do nothing after
 * it. The HUD is read once more right after the frame that reported it.
 *
 * **Example** (A lost run of one hero)
 *
 * ```ts
 * import { RunEnded } from "@arcadekit/survivors";
 *
 * const ended = new RunEnded({
 *   summaries: [{ won: false, heroId: "bolter", heroName: "Bolter", time: 95.5, kills: 140, level: 7 }],
 * });
 * ended.summaries[0]?.won; // => false
 * ```
 *
 * @category declarations
 */
export class RunEnded extends Game.Event("RunEnded", {
  summaries: Schema.Array(Hero.Summary),
}) {}
