import type { PlayerInputs } from "arcadekit/runtime";
import { Schema } from "effect";

// A survivors step's input: every player's input for that step, plus the players leaving at it.
// Anything that changes a run (an upgrade pick, a co-op pause, a player leaving) arrives here,
// scheduled for a step, so every lockstep peer applies it at the same step (ADR-0012).

/** An upgrade pick: the index of a choice in the offer numbered `offer` (`World.offerSeq`). */
export const UpgradePick = Schema.Struct({
  offer: Schema.Number,
  index: Schema.Number,
});
export type UpgradePick = typeof UpgradePick.Type;

/**
 * One player's input for one step: what crosses the network in a lockstep run (use it with
 * `arcadekit/net`'s `schemaCodec`).
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
 * A survivors step's input: `arcadekit/runtime`'s `PlayerInputs` of `HeroInput`. `players[slot]`
 * is the input of the player whose hero is at that slot, or null for a hero with no input this
 * step (it stands still). `leaving` lists the slots of the heroes whose players leave the run at
 * this step, in ascending order.
 *
 * `arcadekit/runtime`'s `soloInput` makes it from one player's source, and `arcadekit/net`'s
 * `combinePlayerInputs` from lockstep's confirmed steps, given the run's player order, which
 * must be the order of the run's `heroIds`.
 */
export type SurvivorsInput = PlayerInputs<HeroInput>;
