import { Rng } from "../core/index";
import type { PeerId, Transport } from "./transport";

export interface MemoryNetworkOptions {
  /** Seeds the network's own `Rng`, so a test's latency, loss and reordering are the same each run. */
  readonly seed: number;
  /** Least time a message takes to arrive. Defaults to 0. */
  readonly latencyMs?: number;
  /** Extra delay, uniform in [0, jitterMs), drawn per message. Jitter reorders messages. Defaults to 0. */
  readonly jitterMs?: number;
  /** Chance, in [0, 1], that a message is lost. Defaults to 0. */
  readonly loss?: number;
}

/**
 * Peers in one process joined by a simulated network: the in-memory adapter of the `Transport`
 * seam, for tests. Time is the test's: `advance(nowMs)` delivers every message due by then, and
 * a message sent at time t is due at t + latency + jitter, unless it is lost.
 */
export interface MemoryNetwork {
  /** A transport for peer `id` on this network. One per id. */
  readonly connect: (id: PeerId) => Transport;
  /** Moves the network's clock to `nowMs` and delivers, in order of arrival, every message due by then. */
  readonly advance: (nowMs: number) => void;
  /**
   * Cuts peer `id` off (a closed tab, a lost connection) or reconnects it: while cut off, every
   * message it sends or should receive is lost, including those already in flight.
   */
  readonly cutOff: (id: PeerId, cut: boolean) => void;
}

interface InFlight {
  readonly from: PeerId;
  readonly to: PeerId;
  readonly message: string;
  readonly dueMs: number;
  /** Send order, to deliver messages due at the same time in a fixed order. */
  readonly order: number;
}

export const createMemoryNetwork = (
  options: MemoryNetworkOptions
): MemoryNetwork => {
  const rng = Rng.make(options.seed);
  const latencyMs = options.latencyMs ?? 0;
  const jitterMs = options.jitterMs ?? 0;
  const loss = options.loss ?? 0;
  const handlers = new Map<
    PeerId,
    Set<(from: PeerId, message: string) => void>
  >();
  const cut = new Set<PeerId>();
  let inFlight: InFlight[] = [];
  let nowMs = 0;
  let sent = 0;

  const connect = (id: PeerId): Transport => {
    if (handlers.has(id)) {
      throw new Error(`Peer ${id} is already connected to this network`);
    }
    const listeners = new Set<(from: PeerId, message: string) => void>();
    handlers.set(id, listeners);
    return {
      self: id,
      send: (to, message) => {
        // Draw for every message, lost or not, so cutting a peer off doesn't change the others'.
        const lost = Rng.next(rng) < loss;
        const dueMs = nowMs + latencyMs + Rng.next(rng) * jitterMs;
        if (lost || cut.has(id) || cut.has(to)) {
          return;
        }
        inFlight.push({ from: id, to, message, dueMs, order: sent });
        sent += 1;
      },
      listen: (handler) => {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
    };
  };

  const advance = (to: number) => {
    nowMs = Math.max(nowMs, to);
    const due = inFlight
      .filter((m) => m.dueMs <= nowMs)
      .toSorted((a, b) => a.dueMs - b.dueMs || a.order - b.order);
    inFlight = inFlight.filter((m) => m.dueMs > nowMs);
    for (const m of due) {
      if (cut.has(m.from) || cut.has(m.to)) {
        continue;
      }
      for (const handler of handlers.get(m.to) ?? []) {
        handler(m.from, m.message);
      }
    }
  };

  const cutOff = (id: PeerId, isCut: boolean) => {
    if (isCut) {
      cut.add(id);
    } else {
      cut.delete(id);
    }
  };

  return { connect, advance, cutOff };
};
