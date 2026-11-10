import * as Game from "arcadekit/game";
import { Schema } from "effect";

// A survivors step's input: every player's input for that step, plus the players leaving at it.
// In a lockstep run, anything that changes it (an upgrade pick, a co-op pause, a player leaving)
// arrives here, scheduled for a step, so every peer applies it at the same step (ADR-0012). A
// single-player run's pick is the `ChooseUpgrade` command (commands.ts), which the loop applies
// at a step.
//
// A lockstep run's pick still rides the input (`HeroInput.pick`, which the step's `applyPicks`
// applies), as its pause does (`HeroInput.paused`). When co-op moves to the declarations the pick
// becomes the same `ChooseUpgrade`, and `UpgradePick`, the two keys and `applyPicks` go
// (ADR-0020).

/** An upgrade pick: the index of a choice in the offer numbered `offer` (`World.offerSeq`). */
export const UpgradePick = Schema.Struct({
  offer: Schema.Number,
  index: Schema.Number,
});
export type UpgradePick = typeof UpgradePick.Type;

/**
 * One player's input for one step: what crosses the network in a lockstep run, which reads this
 * Schema from `SurvivorsInput`.
 *
 * - `moveX`, `moveZ`: movement direction, each axis in [-1, 1].
 * - `pick`: an upgrade choice. Applied only while this hero has the offer it names open, so a
 *   repeated or late pick does nothing.
 * - `paused`: true holds the run paused for everyone while this player's hero is playing.
 */
export const HeroInput = Schema.Struct({
  moveX: Schema.Number,
  moveZ: Schema.Number,
  pick: Schema.optionalKey(UpgradePick),
  paused: Schema.optionalKey(Schema.Boolean),
});
export type HeroInput = typeof HeroInput.Type;

/**
 * A survivors step's input: every player's `HeroInput`, as a `Game.PlayerInputs`.
 * `players[slot]` is the input of the player whose hero is at that slot, or null for a hero with
 * no input this step (it stands still). `leaving` lists the slots of the heroes whose players
 * leave the run at this step, in ascending order.
 *
 * `Game.soloInput` makes it from one player's source, and a lockstep session from the steps its
 * host confirms, in the run's player order, which must be the order of the run's `heroIds`.
 */
export const SurvivorsInput = Game.PlayerInputs(HeroInput);
export type SurvivorsInput = typeof SurvivorsInput.Type;
