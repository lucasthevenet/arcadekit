import type { PlayerInputs } from "../game/index";
import type { ConfirmedStep } from "./lockstep";
import type { PeerId } from "./transport";

const ascending = (a: number, b: number) => a - b;

/**
 * How a lockstep session makes each step's input, a `Game.PlayerInputs`, from the step its host
 * confirmed: each player's input goes to its slot, and each player removed at a step leaves the
 * run at it. `players` is the run's player order, host first, as the lobby agreed it: the host
 * and its `peers` on the host, `JoinOptions.players` on a guest. It is not
 * `LockstepSession.players`, nor what a start message lists: those are who is still in the run.
 * A player's slot is its index there, so the run's config must list what each player plays in
 * the same order. A player who is not in `players` is skipped, and one whose peer has nothing
 * attached has null at its slot, as one with no input has. The step's commands are not its
 * business: the session hands them to the loop. Plain code: it returns one object, refilled each
 * step.
 */
export const combinePlayerInputs = <PlayerInput>(
  players: readonly PeerId[]
): ((
  step: ConfirmedStep<PlayerInput, unknown>
) => PlayerInputs<PlayerInput>) => {
  const bySlot: (PlayerInput | null)[] = players.map(() => null);
  const leaving: number[] = [];
  const combined: PlayerInputs<PlayerInput> = { players: bySlot, leaving };
  return (step) => {
    bySlot.fill(null);
    leaving.length = 0;
    for (const { player, input } of step.inputs) {
      const slot = players.indexOf(player);
      if (slot !== -1) {
        bySlot[slot] = input;
      }
    }
    for (const player of step.removed) {
      const slot = players.indexOf(player);
      if (slot !== -1) {
        leaving.push(slot);
      }
    }
    leaving.sort(ascending);
    return combined;
  };
};
