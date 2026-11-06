import { Data } from "effect";

import type { ErrorReason } from "../signalling/protocol";

/** Why a room failed: the worker's reasons, and the client's own. */
export type RoomFailure =
  | ErrorReason
  /** The socket didn't open: refused, a malformed URL, or the open timed out. */
  | "unreachable"
  /** The socket closed after it opened, before the start. */
  | "lost"
  /** The typed join code can't be one. No socket is opened. */
  | "bad-code"
  /** A guest couldn't open its link to the host, or that link closed before the start. */
  | "peer-failed"
  /** The socket opened, but no welcome came in time. */
  | "no-welcome"
  /** The worker sent text this client can't read: it speaks another version of the protocol. */
  | "bad-server-message";

// Named so the type files can be made one file at a time (isolatedDeclarations).
const RoomErrorBase: ReturnType<typeof Data.TaggedError<"RoomError">> =
  Data.TaggedError("RoomError");

/**
 * A room that failed before the start. `message` says why, for a player; `cause` is the socket's
 * error when there is one.
 */
export class RoomError extends RoomErrorBase<{
  readonly reason: RoomFailure;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * `reason` as a RoomError, with its message for a player unless `message` is given. `url` is the
 * worker's base URL.
 */
export const roomError = (
  reason: RoomFailure,
  url: string,
  details: { readonly message?: string; readonly cause?: unknown } = {}
): RoomError => {
  const message = details.message ?? failureMessage(reason, url);
  return details.cause === undefined
    ? new RoomError({ reason, message })
    : new RoomError({ reason, message, cause: details.cause });
};

/** What a player is told when a room fails with `reason`. `url` is the worker's base URL. */
export const failureMessage = (reason: RoomFailure, url: string): string => {
  switch (reason) {
    case "unknown-code": {
      return "No room has that code. Check it, or ask the host for a new one.";
    }
    case "code-taken": {
      return "That join code is already in use. Try hosting again.";
    }
    case "full": {
      return "That room is full.";
    }
    case "started": {
      return "That run has already started.";
    }
    case "expired": {
      return "The room expired. Host a new one.";
    }
    case "host-left": {
      return "The host left.";
    }
    case "bad-message":
    case "not-allowed": {
      return `The signalling server refused a message (${reason}).`;
    }
    case "unreachable": {
      return `Couldn't reach the signalling server at ${url}.`;
    }
    case "lost": {
      return "Lost the connection to the signalling server.";
    }
    case "bad-code": {
      return "A join code is 6 letters and digits.";
    }
    case "peer-failed": {
      return "Couldn't connect to the host.";
    }
    case "no-welcome": {
      return "The signalling server didn't answer. Try again in a moment.";
    }
    case "bad-server-message": {
      return "The signalling server speaks another version of the game's protocol. Reload the page.";
    }
  }
};
