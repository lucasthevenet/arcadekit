// Lockstep multiplayer: every peer steps the same `Game.Simulation` on the inputs the host
// confirms for each step (ADR-0012). A session is a host of the simulation, as `Game.Engine` is:
// it steps it through a `Game.Loop`, reads from its declared `Game.PlayerInputs` what one player
// sends, and carries a player's commands to every peer's rules at one step (`send`). It knows no
// network; it talks through a Transport. It comes plain
// (`hostLockstep`, ticked by hand) and in an Effect shell (`hostLockstepScoped`, owned by a
// scope, run on Effect's Clock or a ticker, failing with its LockstepError).
// No DOM here; the WebRTC transport, the signalling client and the `Coop` declaration, a game
// for several players from a lobby, are in "arcadekit/net/browser".

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
