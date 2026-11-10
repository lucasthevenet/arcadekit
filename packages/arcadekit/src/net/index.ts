// Lockstep multiplayer: every peer steps the same `Game.Simulation` on the inputs the host
// confirms for each step (ADR-0012). A session is a host of the simulation, as `Game.Engine` is:
// it steps it through a `Game.Loop`, reads from its declared `Game.PlayerInputs` what one player
// sends, and carries a player's commands to every peer's rules at one step (`send`). It knows no
// network; it talks through a Transport. It comes plain
// (`hostLockstep`, ticked by hand) and in an Effect shell (`hostLockstepScoped`, owned by a
// scope, run on Effect's Clock or a ticker, failing with its LockstepError).
// It also has a Co-op game's DOM-free half: its lockstep parts (`CoopRules`). The Co-op client
// that runs them is in the browser entry, with the lobby and the content hash behind it.
// No DOM here; the WebRTC transport, the signalling client and the Co-op client are in
// "arcadekit/net/browser".

export type { CoopRules, CoopTypes } from "./coop";
export { LockstepError, type RemovedWhy, type StopReason } from "./errors";
export {
  type HostOptions,
  type JoinOptions,
  type LockstepOptions,
  type LockstepSession,
  type LockstepStatus,
  hostLockstep,
  joinLockstep,
} from "./lockstep";
export {
  type MemoryNetwork,
  type MemoryNetworkOptions,
  createMemoryNetwork,
} from "./memory-network";
export {
  type ScopedLockstepSession,
  type Ticker,
  hostLockstepScoped,
  joinLockstepScoped,
} from "./scoped";
export type { PeerId, Transport } from "./transport";
