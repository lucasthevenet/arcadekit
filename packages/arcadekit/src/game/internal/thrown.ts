// What the entry's errors share and no game calls: the message of what was thrown, for an error
// that carries the throw as its `cause` (`AttachError`, `GameCrashed`).

/** The message of what was thrown: an `Error`'s own, or the value written as a string. */
export const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
