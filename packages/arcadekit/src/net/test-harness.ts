import { Duration, Effect, Scheduler } from "effect";
import type { Clock } from "effect";

import type { MemoryNetwork } from "./memory-network";

// Test support, not exported from the root entry: drives sessions and their network on one
// simulated clock, and gives a Co-op client's tests the Clock and Scheduler of a page.

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

const nanos = (ms: number) => BigInt(Math.round(ms * 1_000_000));

/**
 * Effect's Clock on the page's timers, which a test fakes: Effect's own reads `process.hrtime`
 * in Node, which fake timers don't reach.
 */
export const performanceClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => Date.now(),
  currentTimeMillis: Effect.sync(() => Date.now()),
  currentTimeNanosUnsafe: () => nanos(Date.now()),
  currentTimeNanos: Effect.sync(() => nanos(Date.now())),
  monotonicTimeNanosUnsafe: () => nanos(performance.now()),
  monotonicTimeNanos: Effect.sync(() => nanos(performance.now())),
  sleep: (duration) =>
    Effect.callback((resume) => {
      const timer = setTimeout(
        () => resume(Effect.void),
        Duration.toMillis(duration)
      );
      return Effect.sync(() => clearTimeout(timer));
    }),
};

/**
 * Runs fibers on microtasks, as Foldkit's browser scheduler does, so no fiber waits on a real
 * `setImmediate` under fake timers.
 */
export const microtasks: Scheduler.Scheduler = new Scheduler.MixedScheduler(
  "async",
  (task) => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        task();
      }
    });
    return () => {
      cancelled = true;
    };
  }
);
