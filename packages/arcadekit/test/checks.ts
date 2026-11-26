/**
 * Checks that a loop takes on some of its turns, held until the loop is done.
 * An expect in a branch passes on every turn the branch is not taken, so a
 * test whose branch is never taken checks nothing.
 *
 * And what an effect fails or dies with, as a call that throws it.
 */
import { expect } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";

export interface Checks {
  /** Holds what was seen and what was wanted, for `expectChecked`. */
  readonly check: (what: string, seen: unknown, wanted: unknown) => void;
  readonly seen: readonly (readonly [string, unknown])[];
  readonly wanted: readonly (readonly [string, unknown])[];
}

export const makeChecks = (): Checks => {
  const seen: [string, unknown][] = [];
  const wanted: [string, unknown][] = [];
  return {
    check: (what, value, expected) => {
      seen.push([what, value]);
      wanted.push([what, expected]);
    },
    seen,
    wanted,
  };
};

/**
 * Fails unless at least `least` checks were taken, and then if any saw what
 * it was not to see.
 */
export const expectChecked = (checks: Checks, least: number): void => {
  expect(checks.seen.length).toBeGreaterThanOrEqual(least);
  expect(checks.seen).toEqual(checks.wanted);
};

/**
 * Runs `effect`, and returns a call that throws what it failed or died with,
 * as one error, or does nothing when it succeeded: for `toThrow`, which then
 * says what the effect was to fail with.
 *
 *   expect(yield* thrown(app.tick(1))).toThrow(/between ticks/)
 */
export const thrown = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<() => void, never, R> =>
  Effect.map(Effect.exit(effect), (exit) => () => {
    if (Exit.isFailure(exit)) {
      throw Cause.squash(exit.cause);
    }
  });
