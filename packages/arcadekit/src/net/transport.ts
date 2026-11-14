/**
 * Transports: how a lockstep session's messages travel between the peers of one run.
 *
 * A transport is the seam between a lockstep session and the network: text to a peer by its id,
 * and a listener for what arrives. It has two adapters in the kit, the in-memory network for
 * tests (`MemoryNetwork`) and WebRTC's peer links in the browser (`arcadekit/net/browser`'s
 * `RtcTransport`). Plain on purpose (ADR-0024): a session sends from inside its tick, which
 * finishes in the call, and what arrives is queued for the next tick to read, as state a step
 * reads is written while the host dispatches its event.
 *
 * @since 0.7.0
 */
import { Inspectable, Pipeable, Predicate } from "effect";
import type { Types } from "effect";

const TypeId = "~arcadekit/net/Transport";

/**
 * A peer's address on a transport: unique within one lockstep run.
 *
 * **When to use**
 *
 * To name the peers a host plays with (`peers`), the host a guest joins (`host`) and the run's
 * player order (`players`).
 *
 * **Details**
 *
 * The signalling worker gives `host`, `guest-1`, `guest-2` and so on, in join order. On the
 * in-memory network a test names its peers as it likes.
 *
 * **Example** (The peers of a run, host first)
 *
 * ```ts
 * import type { Transport } from "arcadekit/net";
 *
 * const players: readonly Transport.PeerId[] = ["host", "guest-1"];
 * players[0]; // => "host"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type PeerId = string;

/**
 * Carries text messages between the peers of one lockstep run.
 *
 * **When to use**
 *
 * Hand one to a lockstep session as its `transport`: `MemoryNetwork.connect` gives a test's, and
 * `arcadekit/net/browser`'s `RtcTransport.fromLinks` the browser's. Make one with `make` to
 * carry a session over a network of the app's own.
 *
 * **Details**
 *
 * A transport may lose, delay, duplicate and reorder messages: the session resends what isn't
 * acknowledged and ignores what it already has, so an unreliable, unordered channel is enough.
 * It need not reach every peer, only the ones the session sends to: in the host star, a guest
 * talks to the host alone. `send` never throws, since a message to an unknown or gone peer is
 * lost. A handler that `listen` is given must not send synchronously: the session only queues
 * what arrives, and reads it at its next tick.
 *
 * **Example** (A transport that loops back to itself)
 *
 * ```ts
 * import { Transport } from "arcadekit/net";
 *
 * const handlers = new Set<(from: string, message: string) => void>();
 * const loopback = Transport.make({
 *   self: "solo",
 *   send: (_to, message) => {
 *     for (const handler of handlers) {
 *       handler("solo", message);
 *     }
 *   },
 *   listen: (handler) => {
 *     handlers.add(handler);
 *     return () => handlers.delete(handler);
 *   },
 * });
 * const heard: string[] = [];
 * const stop = loopback.listen((_from, message) => heard.push(message));
 * loopback.send("solo", "ping");
 * stop();
 * loopback.send("solo", "lost");
 * heard; // => ["ping"]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Transport extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  /** This peer's id. */
  readonly self: PeerId;
  /** Sends one message to `to`. Never throws: a message to an unknown or gone peer is lost. */
  readonly send: (to: PeerId, message: string) => void;
  /** Calls `handler` with each message that arrives, until the returned function is called. */
  readonly listen: (
    handler: (from: PeerId, message: string) => void
  ) => () => void;
}

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: Transport) {
    return { _id: "Transport", self: this.self };
  },
};

/**
 * Checks whether a value is a transport.
 *
 * **When to use**
 *
 * Narrow an unknown value before handing it to a lockstep session.
 *
 * **Details**
 *
 * A transport comes from `make`, `MemoryNetwork.connect` or `RtcTransport.fromLinks`. An object
 * with a `send` and a `listen` of its own is none.
 *
 * **Example** (Recognising a transport)
 *
 * ```ts
 * import { MemoryNetwork, Transport } from "arcadekit/net";
 *
 * const network = MemoryNetwork.make({ seed: 1 });
 * Transport.isTransport(MemoryNetwork.connect(network, "host")); // => true
 * Transport.isTransport({ self: "host", send: () => {}, listen: () => () => {} }); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isTransport = (value: unknown): value is Transport =>
  Predicate.hasProperty(value, TypeId);

/**
 * Makes a transport from this peer's id and the two calls that carry its messages.
 *
 * **When to use**
 *
 * To carry a lockstep session over a network the kit has no adapter for, such as a relay of the
 * app's own. A test uses `MemoryNetwork`, and a browser `RtcTransport.fromLinks`.
 *
 * **Details**
 *
 * `make` calls neither: each call of the transport calls what it was given. A transport prints
 * as `{ _id: "Transport", self }`.
 *
 * **Example** (A transport that drops everything)
 *
 * ```ts
 * import { Transport } from "arcadekit/net";
 *
 * const nowhere = Transport.make({
 *   self: "host",
 *   send: () => {},
 *   listen: () => () => {},
 * });
 * nowhere.self; // => "host"
 * nowhere.toJSON(); // => { _id: "Transport", self: "host" }
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = (
  calls: Pick<Transport, "self" | "send" | "listen">
): Transport => {
  const self = Object.create(Proto) as Types.Mutable<Transport>;
  self.self = calls.self;
  self.send = calls.send;
  self.listen = calls.listen;
  return self;
};
