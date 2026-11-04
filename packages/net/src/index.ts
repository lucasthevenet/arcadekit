// Lockstep multiplayer (ADR-0012). No DOM here; a WebRTC transport will be in
// "@gamekit/net/browser".

export {
  type MemoryNetwork,
  type MemoryNetworkOptions,
  createMemoryNetwork,
} from "./memory-network";
export type { PeerId, Transport } from "./transport";
