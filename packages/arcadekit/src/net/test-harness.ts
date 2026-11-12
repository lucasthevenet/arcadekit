import type { MemoryNetwork } from "./memory-network";

// Test support, not exported from the root entry: drives sessions and their network on one
// simulated clock. What a Co-op client's tests run their Effects on, under fake timers, is the
// entry's: `onFakeTimers` in "arcadekit/net/testing".

export interface Ticked {
  readonly session: { readonly tick: (nowMs: number) => void };
  /** How often this peer's timer ticks. Peers tick at different rates, as browsers would. */
  readonly everyMs: number;
}

/** Advances the network and ticks each session on its own timer, from `fromMs` up to `toMs`. */
export const runNetwork = (
  network: MemoryNetwork,
  peers: readonly Ticked[],
  fromMs: number,
  toMs: number
): void => {
  for (let nowMs = fromMs; nowMs <= toMs; nowMs++) {
    network.advance(nowMs);
    for (const { session, everyMs } of peers) {
      if (nowMs % everyMs === 0) {
        session.tick(nowMs);
      }
    }
  }
};

/** FNV-1a over numbers' float64 bits, so any change in any digit shows. */
export const hasher = (): {
  readonly add: (value: number) => void;
  readonly value: number;
} => {
  let hash = 0x81_1c_9d_c5;
  const bits = new Float64Array(1);
  const bytes = new Uint8Array(bits.buffer);
  return {
    add: (value: number) => {
      bits[0] = value;
      for (const byte of bytes) {
        hash = Math.imul(hash ^ byte, 0x01_00_01_93) >>> 0;
      }
    },
    get value() {
      return hash;
    },
  };
};
