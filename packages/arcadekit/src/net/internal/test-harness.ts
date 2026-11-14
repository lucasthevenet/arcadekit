import { MemoryNetwork } from "../index";

// Test support, not exported from the root entry: drives sessions and their network on one
// simulated clock. What a Co-op client's tests run their Effects on, under fake timers, is the
// entry's: `PageTimers.layer` in "arcadekit/net/testing".

export interface Ticked {
  readonly session: { readonly tick: (nowMs: number) => void };
  /** How often this peer's timer ticks. Peers tick at different rates, as browsers would. */
  readonly everyMs: number;
}

/** Advances the network and ticks each session on its own timer, from `fromMs` up to `toMs`. */
export const runNetwork = (
  network: MemoryNetwork.MemoryNetwork,
  peers: readonly Ticked[],
  fromMs: number,
  toMs: number
): void => {
  for (let nowMs = fromMs; nowMs <= toMs; nowMs++) {
    MemoryNetwork.advance(network, nowMs);
    for (const { session, everyMs } of peers) {
      if (nowMs % everyMs === 0) {
        session.tick(nowMs);
      }
    }
  }
};
