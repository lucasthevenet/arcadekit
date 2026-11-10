import * as Game from "arcadekit/game";
import { Schema } from "effect";

// A survivors step's input: every player's input for that step, plus the players leaving at it.
// It holds what a player's devices hold and nothing else. What a player decides outside them
// (an upgrade pick, the co-op pause) is a command (commands.ts), which every host applies at a
// step: the single-player engine at its next one, and a lockstep run at the step the command
// rides, on every peer (ADR-0012, ADR-0020).

/**
 * One player's input for one step: what its devices hold, and what crosses the network for that
 * player in a lockstep run, which reads this Schema from `SurvivorsInput`.
 *
 * - `moveX`, `moveZ`: movement direction, each axis in [-1, 1].
 */
export const HeroInput = Schema.Struct({
  moveX: Schema.Number,
  moveZ: Schema.Number,
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
