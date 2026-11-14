/**
 * Peer connectors: how a signalling room makes its peer links, one peer at a time.
 *
 * A connector is a service a signalling room reads: it connects to one peer through the signals
 * the room relays, and gives the link once both its channels are open. `RtcPeerConnector` is the
 * browser's, over WebRTC; a test provides one of its own. Its `connect` is an Effect with a
 * lifecycle: the scope it runs in owns the connection and both channels from the moment each is
 * made, and closing it closes them all, however `connect` ended.
 *
 * @since 0.7.0
 */
import {
  Context,
  Effect,
  Inspectable,
  Pipeable,
  Predicate,
  Schema,
} from "effect";
import type { Cause, Queue, Scope, Types } from "effect";

import type { Signal } from "../signalling/index";
import type * as Transport from "../transport";
import type * as PeerLink from "./peer-link";

const TypeId = "~arcadekit/net/browser/PeerConnector";

/**
 * What a connector is told about one peer to connect to.
 *
 * **When to use**
 *
 * To read what a signalling room hands a connector of the app's own, or a test's.
 *
 * **Details**
 *
 * - `initiator` is true on the side that makes the offer: the host, in the star.
 * - `signals` holds the peer's signals, in the order the worker relayed them. A connection
 *   applies them one at a time.
 * - `sendSignal` sends a signal to the peer through the worker. It is plain: a connection calls
 *   it for each ICE candidate, while the browser dispatches the candidate's event.
 *
 * **Example** (A guest's side of its link to the host)
 *
 * ```ts
 * import type { PeerConnector } from "arcadekit/net/browser";
 * import { Effect, Queue } from "effect";
 *
 * const signals = Effect.runSync(Queue.unbounded<never>());
 * const options: PeerConnector.ConnectOptions = {
 *   peer: "host",
 *   initiator: false,
 *   signals,
 *   sendSignal: () => {},
 * };
 * options.initiator; // => false
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface ConnectOptions {
  readonly peer: Transport.PeerId;
  /** True on the side that makes the offer: the host, in the star. */
  readonly initiator: boolean;
  /** Signals from the peer, in the order the worker relayed them. */
  readonly signals: Queue.Dequeue<Signal.Signal>;
  /** Sends a signal to the peer through the signalling worker. Plain: it is called for each ICE candidate. */
  readonly sendSignal: (signal: Signal.Signal) => void;
}

/** The class `Schema.TaggedError` makes for `PeerLinkError`, written out for isolatedDeclarations. */
type PeerLinkErrorClass = Schema.Class<
  PeerLinkError,
  Schema.TaggedStruct<
    "PeerLinkError",
    {
      readonly peer: Schema.String;
      readonly reason: Schema.Literals<readonly ["setup", "failed", "timeout"]>;
      readonly message: Schema.String;
      readonly cause: Schema.optional<Schema.Defect>;
    }
  >,
  Cause.YieldableError
>;

// Named so the type files can be made one file at a time (isolatedDeclarations).
const PeerLinkErrorBase: PeerLinkErrorClass =
  // oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError makes a class; it is not an error being thrown.
  Schema.TaggedError<PeerLinkError>()("PeerLinkError", {
    peer: Schema.String,
    reason: Schema.Literals(["setup", "failed", "timeout"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  });

/**
 * A peer link that couldn't be made: setting it up threw (`setup`), ICE failed (`failed`), or its
 * channels didn't open in time (`timeout`). `message` says why, for a player; `cause` is what was
 * thrown, if anything was.
 *
 * **When to use**
 *
 * Fail a connector's `connect` with it. A signalling room catches it: a host's room reports the
 * guest as left, and a guest's room fails with `peer-failed`.
 *
 * **Example** (A connection that timed out)
 *
 * ```ts
 * import { PeerConnector } from "arcadekit/net/browser";
 *
 * const error = new PeerConnector.PeerLinkError({
 *   peer: "guest-1",
 *   reason: "timeout",
 *   message: "Couldn't connect to guest-1 directly in time.",
 * });
 * error._tag; // => "PeerLinkError"
 * error.reason; // => "timeout"
 * ```
 *
 * @category errors
 * @since 0.7.0
 */
export class PeerLinkError extends PeerLinkErrorBase {}

/**
 * What makes a signalling room's peer links: a `connect` per peer.
 *
 * **When to use**
 *
 * Name it to type a connector, and yield its key, `PeerConnector.PeerConnector`, where a room
 * needs one. An app provides the browser's with `RtcPeerConnector.layer`, or a signalling room's
 * `layer`; a test provides one made with `make`.
 *
 * **Details**
 *
 * `connect` succeeds with the peer's link once both channels are open. The scope owns the
 * connection and both data channels from the moment each is made, and closing it closes them
 * all, however `connect` ended: run each attempt in a scope of its own to release a failed one at
 * once. It fails with a `PeerLinkError` if setting up throws, ICE fails, or the channels don't
 * open in time.
 *
 * **Example** (A connector that never connects)
 *
 * ```ts
 * import { PeerConnector } from "arcadekit/net/browser";
 * import type { Signal } from "arcadekit/net/signalling";
 * import { Effect, Queue } from "effect";
 *
 * const refusing = PeerConnector.make({
 *   connect: ({ peer }) =>
 *     Effect.fail(new PeerConnector.PeerLinkError({ peer, reason: "failed", message: "No route" })),
 * });
 * const tried = Effect.gen(function* () {
 *   const signals = yield* Queue.unbounded<Signal.Signal>();
 *   const options = { peer: "host", initiator: false, signals, sendSignal: () => {} };
 *   return yield* Effect.flip(refusing.connect(options));
 * }).pipe(Effect.scoped);
 * Effect.runSync(tried).reason; // => "failed"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface PeerConnector
  extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  /** Connects to one peer, and succeeds with its link once both channels are open. */
  readonly connect: (
    options: ConnectOptions
  ) => Effect.Effect<PeerLink.PeerLink, PeerLinkError, Scope.Scope>;
}

/**
 * The key of the peer connector a signalling room makes its links with, as a service:
 * `yield* PeerConnector.PeerConnector` gives it.
 *
 * **When to use**
 *
 * To provide a connector to a signalling room: `RtcPeerConnector.layer` gives WebRTC's, and a test
 * provides its own with `Layer.succeed`.
 *
 * **Details**
 *
 * It is keyed `arcadekit/net/browser/PeerConnector`, and its type is the connector's.
 *
 * **Example** (Providing a test's connector)
 *
 * ```ts
 * import { PeerConnector } from "arcadekit/net/browser";
 * import { Effect, Layer } from "effect";
 *
 * const never = PeerConnector.make({ connect: () => Effect.never });
 * const program = Effect.gen(function* () {
 *   return yield* PeerConnector.PeerConnector;
 * });
 * const given = Effect.runSync(program.pipe(Effect.provide(Layer.succeed(PeerConnector.PeerConnector, never))));
 * given === never; // => true
 * ```
 *
 * @category services
 * @since 0.7.0
 */
export const PeerConnector: Context.Service<PeerConnector, PeerConnector> =
  Context.Service<PeerConnector>("arcadekit/net/browser/PeerConnector");

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON() {
    return { _id: "PeerConnector" };
  },
};

/**
 * Checks whether a value is a peer connector.
 *
 * **When to use**
 *
 * Narrow an unknown value before connecting with it.
 *
 * **Example** (Recognising a connector)
 *
 * ```ts
 * import { PeerConnector } from "arcadekit/net/browser";
 * import { Effect } from "effect";
 *
 * PeerConnector.isPeerConnector(PeerConnector.make({ connect: () => Effect.never })); // => true
 * PeerConnector.isPeerConnector({ connect: () => Effect.never }); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isPeerConnector = (value: unknown): value is PeerConnector =>
  Predicate.hasProperty(value, TypeId);

/**
 * Makes a connector from its `connect`.
 *
 * **When to use**
 *
 * In a test of a signalling room, or of an app over one, to connect peers some other way than
 * WebRTC. The browser's is `RtcPeerConnector.make`.
 *
 * **Details**
 *
 * `make` calls nothing: each `connect` of the connector runs what it was given, traced as
 * `PeerConnector.connect`.
 *
 * **Example** (A connector that links at once)
 *
 * ```ts
 * import { PeerConnector, PeerLink } from "arcadekit/net/browser";
 * import { Effect } from "effect";
 *
 * const quiet: PeerLink.TextChannel = {
 *   send: () => {},
 *   listen: () => () => {},
 *   onClose: () => () => {},
 *   isOpen: () => true,
 * };
 * const instant = PeerConnector.make({
 *   connect: ({ peer }) =>
 *     Effect.succeed(PeerLink.make({ peer, lockstep: quiet, messages: quiet, closed: Effect.never })),
 * });
 * instant.toJSON(); // => { _id: "PeerConnector" }
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = (calls: Pick<PeerConnector, "connect">): PeerConnector => {
  const self = Object.create(Proto) as Types.Mutable<PeerConnector>;
  self.connect = Effect.fn("PeerConnector.connect")(function* (
    options: ConnectOptions
  ) {
    return yield* calls.connect(options);
  });
  return self;
};
