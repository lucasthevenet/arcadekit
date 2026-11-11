import { Data } from "effect";

import { messageOf } from "./frame-loop";

// Named so the type files can be made one file at a time (isolatedDeclarations).
const AttachErrorBase: ReturnType<typeof Data.TaggedError<"AttachError">> =
  Data.TaggedError("AttachError");

/**
 * An engine that couldn't attach: making its view or input source threw, such as Three.js
 * finding no WebGL. `cause` is what was thrown.
 */
export class AttachError extends AttachErrorBase<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/** An AttachError for what attaching threw. */
export const attachError = (cause: unknown): AttachError =>
  new AttachError({ message: messageOf(cause), cause });
