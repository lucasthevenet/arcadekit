// Lockstep multiplayer: every peer runs the same GameSimulation on the inputs the host confirms
// for each step (ADR-0012). The session knows no network; it talks through a Transport.
// No DOM here; the WebRTC transport and the signalling client are in "@arcadekit/net/browser".

export { type InputCodec, jsonCodec, schemaCodec } from "./codec";
export { LockstepError, type RemovedWhy, type StopReason } from "./errors";
export {
  type ConfirmedStep,
  type HostOptions,
  type JoinOptions,
  type LockstepOptions,
  type LockstepSession,
  type LockstepStatus,
  type PlayerStepInput,
  hostLockstep,
  joinLockstep,
} from "./lockstep";
export {
  type MemoryNetwork,
  type MemoryNetworkOptions,
  createMemoryNetwork,
} from "./memory-network";
export type { PeerId, Transport } from "./transport";
