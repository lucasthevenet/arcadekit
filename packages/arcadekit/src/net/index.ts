// Lockstep multiplayer: every peer runs the same GameSimulation on the inputs the host confirms
// for each step (ADR-0012). The session knows no network; it talks through a Transport. It comes
// plain (`hostLockstep`, ticked by hand) and in an Effect shell (`hostLockstepScoped`, owned by a
// scope, run on Effect's Clock or a ticker, failing with its LockstepError).
// It also has a Co-op game's DOM-free half: its lockstep parts (`CoopRules`). The Co-op client
// that runs them is in the browser entry, with the lobby and the content hash behind it.
// No DOM here; the WebRTC transport, the signalling client and the Co-op client are in
// "arcadekit/net/browser".

export { type InputCodec, jsonCodec, schemaCodec } from "./codec";
export type { CoopRules, CoopTypes } from "./coop";
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
export { combinePlayerInputs } from "./player-inputs";
export {
  type ScopedLockstepSession,
  type Ticker,
  hostLockstepScoped,
  joinLockstepScoped,
} from "./scoped";
export type { PeerId, Transport } from "./transport";
