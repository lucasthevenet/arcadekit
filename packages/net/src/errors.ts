import { Data } from "effect";

import type { PeerId } from "./transport";

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
  /** The host removed this peer's player at `step`, after stepping stalled on its input for `dropAfterMs`. */
  | { readonly kind: "removed"; readonly peer: PeerId; readonly step: number }
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
      return `The host removed ${reason.peer} from the run at step ${reason.step}`;
    }
    case "hostLost": {
      return `Lost the host ${reason.host}: nothing heard for ${Math.round(reason.silentMs)} ms`;
    }
  }
};

export const lockstepError = (reason: StopReason): LockstepError =>
  new LockstepError({ message: describe(reason), reason });
