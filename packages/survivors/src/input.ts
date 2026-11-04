import type { StepInput } from "@gamekit/runtime";
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
 * `@gamekit/net`'s `schemaCodec`).
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

/** A survivors step's input. */
export interface SurvivorsInput {
  /** Each hero's input, by slot. Null for a hero with no input this step (it stands still). */
  readonly heroes: readonly (HeroInput | null)[];
  /** The slots of the heroes whose players leave the run at this step, in ascending order. */
  readonly leaving: readonly number[];
}

/**
 * A single player's step input from one player's source: hero 0's input, nobody leaving.
 * Returns one object, refilled each step. `endStep` and `endFrame` reach `source`.
 */
export const soloInput = (
  source: StepInput<HeroInput>
): StepInput<SurvivorsInput> => {
  const heroes: (HeroInput | null)[] = [null];
  const input: SurvivorsInput = { heroes, leaving: [] };
  return {
    read: (step) => {
      heroes[0] = source.read(step);
      return input;
    },
    endStep: () => source.endStep?.(),
    endFrame: () => source.endFrame?.(),
  };
};

/** One lockstep step, as `@gamekit/net`'s `ConfirmedStep<HeroInput>` has it. */
export interface PlayersStep {
  readonly inputs: readonly {
    readonly player: string;
    readonly input: HeroInput;
  }[];
  readonly removed: readonly string[];
}

const ascending = (a: number, b: number) => a - b;

/**
 * A lockstep session's `combine` for survivors: each player's input goes to its hero, and each
 * player removed at a step leaves the run at it. `players` is the run's player order, host first
 * (the lobby's, which is `LockstepSession.players` at the start); a player's slot, and its hero's,
 * is its index there, so the run's `heroIds` must be in the same order. Returns one object,
 * refilled each step.
 */
export const combineHeroInputs = (
  players: readonly string[]
): ((step: PlayersStep) => SurvivorsInput) => {
  const heroes: (HeroInput | null)[] = players.map(() => null);
  const leaving: number[] = [];
  const input: SurvivorsInput = { heroes, leaving };
  return (step) => {
    heroes.fill(null);
    leaving.length = 0;
    for (const { player, input: heroInput } of step.inputs) {
      const slot = players.indexOf(player);
      if (slot !== -1) {
        heroes[slot] = heroInput;
      }
    }
    for (const player of step.removed) {
      const slot = players.indexOf(player);
      if (slot !== -1) {
        leaving.push(slot);
      }
    }
    leaving.sort(ascending);
    return input;
  };
};
