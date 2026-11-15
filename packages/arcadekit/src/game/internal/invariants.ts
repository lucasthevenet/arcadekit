// A simulation's invariants, checked: what a scenario and a loop made with `checkInvariants` run
// when a run starts and after every step. Plain, as the loop is: a check reads the state and
// changes nothing, so a run checked and a run not checked are the same run.
import type { ReadonlyState } from "../readonly-state";

/** A simulation's invariants, as `Game.Simulation` resolves them: each name with its check. */
export type Invariants<State> = readonly (readonly [
  name: string,
  holds: (state: ReadonlyState<State>) => boolean,
])[];

/** The name of the first invariant that doesn't hold of `state`, or undefined if all hold. */
export const brokenInvariant = <State>(
  invariants: Invariants<State>,
  state: State
): string | undefined => {
  // A check is given the run's own state, read-only.
  const read = state as ReadonlyState<State>;
  for (const [name, holds] of invariants) {
    if (holds(read) !== true) {
      return name;
    }
  }
  return undefined;
};

/**
 * What a broken invariant's refusal says: whose and which invariant broke, where, and in which
 * run. `step` is the number of the step that broke it, or null for the state `create` made.
 */
export const brokenMessage = (
  simulation: string,
  invariant: string,
  seed: number,
  step: number | null
): string =>
  step === null
    ? `Simulation "${simulation}" breaks its invariant "${invariant}" as its run starts, with seed ${seed}: create made a state where it doesn't hold.`
    : `Simulation "${simulation}" breaks its invariant "${invariant}" at step ${step} of the run with seed ${seed}: the step, or a command it applied, left the state where it doesn't hold.`;
