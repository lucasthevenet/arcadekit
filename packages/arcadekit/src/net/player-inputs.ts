import type { PlayerInputs } from "../runtime/index";
import type { ConfirmedStep } from "./lockstep";
import type { PeerId } from "./transport";

const ascending = (a: number, b: number) => a - b;

/**
 * A lockstep session's `combine` for a game whose step input is `arcadekit/runtime`'s
 * `PlayerInputs`: each player's input goes to its slot, and each player removed at a step leaves
 * the run at it. `players` is the run's player order, host first (the lobby's, which is
 * `LockstepSession.players` at the start); a player's slot is its index there, so the run's
 * config must list what each player plays in the same order. A player who is not in `players` is
 * skipped. Plain code: it returns one object, refilled each step.
 */
export const combinePlayerInputs = <PlayerInput>(
  players: readonly PeerId[]
): ((step: ConfirmedStep<PlayerInput>) => PlayerInputs<PlayerInput>) => {
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
