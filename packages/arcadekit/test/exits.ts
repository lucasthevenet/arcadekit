import { Cause, Exit } from "effect";

/** The cause of an exit that a test expects to be a failure. */
export const causeOf = <A, E>(exit: Exit.Exit<A, E>): Cause.Cause<E> => {
  if (Exit.isSuccess(exit)) {
    throw new Error(
      `Expected a failure, and it succeeded with ${String(exit.value)}.`
    );
  }
  return exit.cause;
};

/** What an exit that a test expects to be a failure failed with, squashed. */
export const failureOf = <A, E>(exit: Exit.Exit<A, E>): unknown =>
  Cause.squash(causeOf(exit));

/** What an exit failed with, which a test expects to be one of `type`. */
export const failureAs = <A, E, T>(
  exit: Exit.Exit<A, E>,
  type: abstract new (...args: never[]) => T
): T => {
  const failure = failureOf(exit);
  if (!(failure instanceof type)) {
    throw new Error(
      `Expected a ${type.name}, and it failed with ${String(failure)}.`
    );
  }
  return failure;
};
