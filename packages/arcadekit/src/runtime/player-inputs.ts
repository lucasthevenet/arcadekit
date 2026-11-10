import type { StepInput } from "./simulation";

// A step input for a game with several players: every player's input for that step, plus the
// players leaving at it. Plain code, like the step that reads it (ADR-0017): one object,
// refilled each step.

/**
 * One step's input for a game that several players can play: each player's input, by slot, and
 * the slots leaving at this step. A slot is a player's place in the run's player order (host
 * first in lockstep), fixed for the whole run. A game uses it as its `GameSimulation`'s `Input`;
 * `soloInput` fills it for one player, and `arcadekit/net`'s `combinePlayerInputs` from
 * lockstep's confirmed steps.
 */
export interface PlayerInputs<PlayerInput> {
  /** Each player's input, by slot. Null for a player with no input this step. */
  readonly players: readonly (PlayerInput | null)[];
  /** The slots of the players who leave the run at this step, in ascending order. */
  readonly leaving: readonly number[];
}

/**
 * A single player's step input from one player's source: slot 0's input, nobody leaving.
 * Returns one object, refilled each step. `endStep` and `endFrame` reach `source`.
 */
export const soloInput = <PlayerInput>(
  source: StepInput<PlayerInput>
): StepInput<PlayerInputs<PlayerInput>> => {
  const players: (PlayerInput | null)[] = [null];
  const input: PlayerInputs<PlayerInput> = { players, leaving: [] };
  return {
    read: (step) => {
      players[0] = source.read(step);
      return input;
    },
    endStep: () => source.endStep?.(),
    endFrame: () => source.endFrame?.(),
  };
};
