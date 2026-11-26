/** What an effect fails or dies with, as a call that throws it. */
import { Cause, Effect, Exit } from "effect";

/**
 * Runs `effect`, and returns a call that throws what it failed or died with,
 * as one error, or does nothing when it succeeded: for `toThrow`, which then
 * says what the effect was to fail with.
 *
 *   expect(yield* thrown(app.frame())).toThrow(/no colour/)
 */
export const thrown = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<() => void, never, R> =>
  Effect.map(Effect.exit(effect), (exit) => () => {
    if (Exit.isFailure(exit)) {
      throw Cause.squash(exit.cause);
    }
  });
