/**
 * Memory networks: the peers of one process joined by a simulated network, for tests.
 *
 * A memory network is the in-memory adapter of the `Transport` seam. Its time is the test's: a
 * message sent at time t is due at t + latency + jitter, unless it is lost, and `advance(nowMs)`
 * delivers every message due by then. Its latency, jitter and loss are drawn from an `Rng` of its
 * own, so a seeded network loses and reorders the same messages on every run. Plain on purpose
 * (ADR-0024): it is a test's data, whose time comes in as an argument, as a lockstep session's
 * does.
 *
 * @since 0.7.0
 */
import { Inspectable, Pipeable, Predicate } from "effect";
import type { Types } from "effect";
import { dual } from "effect/Function";

import { Rng } from "../core/index";
import { make as makeTransport } from "./transport";
import type * as Transport from "./transport";

const TypeId = "~arcadekit/net/MemoryNetwork";

/**
 * How a memory network carries messages: its seed, and the latency, jitter and loss it draws.
 *
 * **When to use**
 *
 * To make a network for a test of a lockstep run: a seed alone for one that delivers everything
 * at once, and latency, jitter and loss to test a run over a poor connection.
 *
 * **Example** (A network with some delay)
 *
 * ```ts
 * import { MemoryNetwork } from "arcadekit/net";
 *
 * const options: MemoryNetwork.Options = { seed: 1, latencyMs: 30, jitterMs: 10 };
 * MemoryNetwork.make(options).latencyMs; // => 30
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Options {
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
 * seam.
 *
 * **When to use**
 *
 * In a test of a lockstep run, or a bench: each peer's session gets its transport from
 * `connect`, and the test moves the network's time with `advance` before it ticks the sessions.
 *
 * **Details**
 *
 * Its time moves only when `advance` is called, and never back. A message sent while either end
 * is cut off is lost, and so is one in flight when either is.
 *
 * **Example** (A message that takes 30 ms)
 *
 * ```ts
 * import { MemoryNetwork } from "arcadekit/net";
 *
 * const network = MemoryNetwork.make({ seed: 1, latencyMs: 30 });
 * const host = MemoryNetwork.connect(network, "host");
 * const guest = MemoryNetwork.connect(network, "guest");
 * const heard: string[] = [];
 * guest.listen((from, message) => heard.push(`${from}: ${message}`));
 * host.send("guest", "hello");
 * MemoryNetwork.advance(network, 29);
 * heard.length; // => 0
 * network.pipe(MemoryNetwork.advance(30));
 * heard; // => ["host: hello"]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface MemoryNetwork
  extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  /** The network's time: the latest `advance` was given. */
  readonly nowMs: number;
  /** Least time a message takes to arrive. */
  readonly latencyMs: number;
  /** Extra delay, uniform in [0, jitterMs), drawn per message. */
  readonly jitterMs: number;
  /** Chance, in [0, 1], that a message is lost. */
  readonly loss: number;
}

interface InFlight {
  readonly from: Transport.PeerId;
  readonly to: Transport.PeerId;
  readonly message: string;
  readonly dueMs: number;
  /** Send order, to deliver messages due at the same time in a fixed order. */
  readonly order: number;
}

/** What the module's functions keep, which no caller reads. */
type Internal = Types.Mutable<MemoryNetwork> & {
  readonly rng: Rng.Rng;
  readonly handlers: Map<
    Transport.PeerId,
    Set<(from: Transport.PeerId, message: string) => void>
  >;
  readonly cut: Set<Transport.PeerId>;
  inFlight: InFlight[];
  sent: number;
};

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: Internal) {
    return {
      _id: "MemoryNetwork",
      nowMs: this.nowMs,
      peers: [...this.handlers.keys()],
      cut: [...this.cut],
      inFlight: this.inFlight.length,
    };
  },
};

/**
 * Checks whether a value is a memory network.
 *
 * **When to use**
 *
 * Narrow an unknown value before connecting a peer to it.
 *
 * **Example** (Recognising a network)
 *
 * ```ts
 * import { MemoryNetwork } from "arcadekit/net";
 *
 * MemoryNetwork.isMemoryNetwork(MemoryNetwork.make({ seed: 1 })); // => true
 * MemoryNetwork.isMemoryNetwork({ nowMs: 0 }); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isMemoryNetwork = (value: unknown): value is MemoryNetwork =>
  Predicate.hasProperty(value, TypeId);

/**
 * Makes a network with no peer, at time 0.
 *
 * **When to use**
 *
 * Once per test of a lockstep run, before its sessions: each connects to it.
 *
 * **Details**
 *
 * It draws two numbers from its `Rng` for every message sent, lost or not, so cutting a peer off
 * doesn't change what the others' messages draw.
 *
 * **Example** (A network that loses every message)
 *
 * ```ts
 * import { MemoryNetwork } from "arcadekit/net";
 *
 * const network = MemoryNetwork.make({ seed: 7, loss: 1 });
 * const host = MemoryNetwork.connect(network, "host");
 * const guest = MemoryNetwork.connect(network, "guest");
 * let heard = 0;
 * guest.listen(() => {
 *   heard += 1;
 * });
 * host.send("guest", "hello");
 * MemoryNetwork.advance(network, 1000);
 * heard; // => 0
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = (options: Options): MemoryNetwork => {
  const self = Object.create(Proto) as Internal;
  Object.assign(self, {
    rng: Rng.make(options.seed),
    latencyMs: options.latencyMs ?? 0,
    jitterMs: options.jitterMs ?? 0,
    loss: options.loss ?? 0,
    handlers: new Map(),
    cut: new Set(),
    inFlight: [],
    nowMs: 0,
    sent: 0,
  });
  return self;
};

/**
 * Connects the peer `id` to the network, and gives its transport.
 *
 * **When to use**
 *
 * Once per peer of a test's run, for its session's `transport`.
 *
 * **Details**
 *
 * One transport per id: connecting an id twice throws, since two sessions can't be one peer.
 *
 * **Example** (Two peers on one network)
 *
 * ```ts
 * import { MemoryNetwork } from "arcadekit/net";
 *
 * const network = MemoryNetwork.make({ seed: 1 });
 * const host = MemoryNetwork.connect(network, "host");
 * const guest = network.pipe(MemoryNetwork.connect("guest"));
 * [host.self, guest.self]; // => ["host", "guest"]
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const connect: {
  (id: Transport.PeerId): (self: MemoryNetwork) => Transport.Transport;
  (self: MemoryNetwork, id: Transport.PeerId): Transport.Transport;
} = dual(
  2,
  (self: MemoryNetwork, id: Transport.PeerId): Transport.Transport => {
    const network = self as Internal;
    if (network.handlers.has(id)) {
      throw new Error(`Peer ${id} is already connected to this network`);
    }
    const listeners = new Set<
      (from: Transport.PeerId, message: string) => void
    >();
    network.handlers.set(id, listeners);
    return makeTransport({
      self: id,
      send: (to, message) => {
        // Draw for every message, lost or not, so cutting a peer off doesn't change the others'.
        const lost = Rng.next(network.rng) < network.loss;
        const dueMs =
          network.nowMs +
          network.latencyMs +
          Rng.next(network.rng) * network.jitterMs;
        if (lost || network.cut.has(id) || network.cut.has(to)) {
          return;
        }
        network.inFlight.push({
          from: id,
          to,
          message,
          dueMs,
          order: network.sent,
        });
        network.sent += 1;
      },
      listen: (handler) => {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
    });
  }
);

/**
 * Moves the network's time to `nowMs` and delivers, in order of arrival, every message due by
 * then.
 *
 * **When to use**
 *
 * Before each tick of a test's sessions, with the time the tick is given.
 *
 * **Details**
 *
 * A time before the network's own is taken as its own: the network never goes back. Messages
 * due at the same time arrive in the order they were sent.
 *
 * **Example** (Delivering what is due)
 *
 * ```ts
 * import { MemoryNetwork } from "arcadekit/net";
 *
 * const network = MemoryNetwork.make({ seed: 1, latencyMs: 10 });
 * const host = MemoryNetwork.connect(network, "host");
 * const guest = MemoryNetwork.connect(network, "guest");
 * const heard: string[] = [];
 * guest.listen((_from, message) => heard.push(message));
 * host.send("guest", "one");
 * MemoryNetwork.advance(network, 5);
 * host.send("guest", "two");
 * MemoryNetwork.advance(network, 15);
 * heard; // => ["one", "two"]
 * network.nowMs; // => 15
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const advance: {
  (nowMs: number): (self: MemoryNetwork) => void;
  (self: MemoryNetwork, nowMs: number): void;
} = dual(2, (self: MemoryNetwork, nowMs: number): void => {
  const network = self as Internal;
  network.nowMs = Math.max(network.nowMs, nowMs);
  const due = network.inFlight
    .filter((m) => m.dueMs <= network.nowMs)
    .toSorted((a, b) => a.dueMs - b.dueMs || a.order - b.order);
  network.inFlight = network.inFlight.filter((m) => m.dueMs > network.nowMs);
  for (const m of due) {
    if (network.cut.has(m.from) || network.cut.has(m.to)) {
      continue;
    }
    for (const handler of network.handlers.get(m.to) ?? []) {
      handler(m.from, m.message);
    }
  }
});

/**
 * Cuts the peer `id` off, as a closed tab or a lost connection, or reconnects it.
 *
 * **When to use**
 *
 * In a test of what a run does when a peer goes silent: the host removes it once stepping has
 * stalled on it, and a guest cut off from its host stops.
 *
 * **Details**
 *
 * While a peer is cut off, every message it sends or should receive is lost, those already in
 * flight included.
 *
 * **Example** (A peer cut off, then back)
 *
 * ```ts
 * import { MemoryNetwork } from "arcadekit/net";
 *
 * const network = MemoryNetwork.make({ seed: 1 });
 * const host = MemoryNetwork.connect(network, "host");
 * const guest = MemoryNetwork.connect(network, "guest");
 * const heard: string[] = [];
 * guest.listen((_from, message) => heard.push(message));
 * MemoryNetwork.cutOff(network, "guest", true);
 * host.send("guest", "lost");
 * MemoryNetwork.cutOff(network, "guest", false);
 * host.send("guest", "heard");
 * MemoryNetwork.advance(network, 0);
 * heard; // => ["heard"]
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const cutOff: {
  (id: Transport.PeerId, cut: boolean): (self: MemoryNetwork) => void;
  (self: MemoryNetwork, id: Transport.PeerId, cut: boolean): void;
} = dual(3, (self: MemoryNetwork, id: Transport.PeerId, cut: boolean): void => {
  const network = self as Internal;
  if (cut) {
    network.cut.add(id);
  } else {
    network.cut.delete(id);
  }
});
