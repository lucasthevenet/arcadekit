import { Data } from "effect";

import type { PeerId } from "./transport";

/** Why the host removed a player: stepping stalled on it, or its input didn't decode. */
export type RemovedWhy = "stalled" | "badInput";

/** Why a lockstep session stopped. */
export type StopReason =
  /** Two peers' states differ: their hashes of the state after `step` steps don't match. */
  | {
      readonly kind: "desync";
      readonly step: number;
      /** Each peer's hash of the state after `step` steps, for the peers that reported one. */
      readonly hashes: Readonly<Record<PeerId, number>>;
    }
  /** The host plays different content, so this peer refused to start. */
  | {
      readonly kind: "contentMismatch";
      readonly hostContentHash: string;
      readonly localContentHash: string;
    }
  /**
   * The host removed this peer's player at `step`: after stepping stalled on its input for
   * `dropAfterMs` (`stalled`), or because an input it sent didn't decode (`badInput`).
   */
  | {
      readonly kind: "removed";
      readonly peer: PeerId;
      readonly step: number;
      readonly why: RemovedWhy;
    }
  /**
   * `player`'s input for `step` didn't decode on this peer: in a step from the host, or, on the
   * host, its own. The peers' one-player Schemas differ (they play other code), or the host's
   * own input doesn't survive the wire (a NaN, which JSON carries as null).
   */
  | {
      readonly kind: "badInput";
      readonly player: PeerId;
      readonly step: number;
      /** What the one-player Schema said is wrong with it. */
      readonly issue: string;
    }
  /** Nothing came from the host for `silentMs`. With no host, no step can be decided. */
  | {
      readonly kind: "hostLost";
      readonly host: PeerId;
      readonly silentMs: number;
    };

// Named so the type files can be made one file at a time (isolatedDeclarations).
const LockstepErrorBase: ReturnType<typeof Data.TaggedError<"LockstepError">> =
  Data.TaggedError("LockstepError");

/** Why a lockstep session stopped for good. Its `reason` holds the details; its message says them. */
export class LockstepError extends LockstepErrorBase<{
  readonly message: string;
  readonly reason: StopReason;
}> {}

const hex = (hash: number) => (hash >>> 0).toString(16).padStart(8, "0");

const describe = (reason: StopReason): string => {
  switch (reason.kind) {
    case "desync": {
      const hashes = Object.entries(reason.hashes)
        .map(([peer, hash]) => `${peer} ${hex(hash)}`)
        .join(", ");
      return `Desync after step ${reason.step}: state hashes differ (${hashes})`;
    }
    case "contentMismatch": {
      return `Content differs from the host's: host ${reason.hostContentHash}, this peer ${reason.localContentHash}`;
    }
    case "removed": {
      const why =
        reason.why === "stalled"
          ? "stepping stalled on its input"
          : "its input didn't decode";
      return `The host removed ${reason.peer} from the run at step ${reason.step}: ${why}`;
    }
    case "badInput": {
      return `The input of ${reason.player} for step ${reason.step} didn't decode: ${reason.issue}`;
    }
    case "hostLost": {
      return `Lost the host ${reason.host}: nothing heard for ${Math.round(reason.silentMs)} ms`;
    }
  }
};

export const lockstepError = (reason: StopReason): LockstepError =>
  new LockstepError({ message: describe(reason), reason });
