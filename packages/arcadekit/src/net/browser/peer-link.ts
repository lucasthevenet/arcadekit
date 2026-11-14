/**
 * Peer links: one WebRTC connection between two peers of a lockstep run, open.
 *
 * A link has two text channels to its peer: `lockstep`, unreliable and unordered, for a lockstep
 * session's transport, which resends what isn't acknowledged on every tick; and `messages`,
 * reliable and ordered, for what the app says around a run (a lobby's picks and its start). A
 * signalling room makes its links through a `PeerConnector`, and the scope that connector ran in
 * owns each: closing it closes both channels and the connection.
 *
 * A channel's calls are plain on purpose (ADR-0024): a lockstep session sends from inside its
 * tick, and what arrives is written while the browser dispatches the message, as host events a
 * tick reads as state are. A lobby feeds a `Queue` from a channel's listener, which is the bridge
 * for events an Effect reacts to. A link's lifecycle is its connector's scope.
 *
 * @since 0.7.0
 */
import { Inspectable, Pipeable, Predicate } from "effect";
import type { Effect, Types } from "effect";

import type * as Transport from "../transport";

const TypeId = "~arcadekit/net/browser/PeerLink";

/**
 * One text pipe to one peer: what an `RTCDataChannel` is to a link.
 *
 * **When to use**
 *
 * To send to a link's peer and hear it. A test writes one as a literal, to stand in for a data
 * channel.
 *
 * **Details**
 *
 * - `send` never throws: a message on a channel that isn't open is lost, and so is one the
 *   browser refuses (a full send buffer).
 * - `listen` calls its handler with each message that arrives, until the returned function is
 *   called. The first listener also gets, at once, what arrived before anything listened, so a
 *   message the other side sends as soon as its end opens isn't lost.
 * - `onClose` calls its handler once when the channel closes, until the returned function is
 *   called: at once, if it has already closed.
 *
 * **Example** (A channel that echoes what it is sent)
 *
 * ```ts
 * import type { PeerLink } from "arcadekit/net/browser";
 *
 * const handlers = new Set<(text: string) => void>();
 * const echo: PeerLink.TextChannel = {
 *   send: (text) => {
 *     for (const handler of handlers) {
 *       handler(text);
 *     }
 *   },
 *   listen: (handler) => {
 *     handlers.add(handler);
 *     return () => handlers.delete(handler);
 *   },
 *   onClose: () => () => {},
 *   isOpen: () => true,
 * };
 * const heard: string[] = [];
 * echo.listen((text) => heard.push(text));
 * echo.send("pick red");
 * heard; // => ["pick red"]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface TextChannel {
  /** Sends one message. Never throws: a message on a channel that isn't open is lost. */
  readonly send: (text: string) => void;
  /** Hears each message that arrives, until the returned function is called. */
  readonly listen: (handler: (text: string) => void) => () => void;
  /** Hears the channel close, once: at once, if it has closed already. */
  readonly onClose: (handler: () => void) => () => void;
  readonly isOpen: () => boolean;
}

/**
 * Two channels to one peer, open: a WebRTC connection once it is set up.
 *
 * **When to use**
 *
 * A signalling room's `links()` gives them, and `RtcTransport.fromLinks` carries a lockstep
 * session over their `lockstep` channels. What the app says around a run goes on `messages`.
 *
 * **Details**
 *
 * `closed` succeeds once the link has closed: either channel closed, the connection failed, or
 * the scope that owns the link closed. It never fails. A link prints its peer and whether each
 * channel is open.
 *
 * **Example** (A link a test makes)
 *
 * ```ts
 * import { PeerLink } from "arcadekit/net/browser";
 * import { Effect } from "effect";
 *
 * const quiet: PeerLink.TextChannel = {
 *   send: () => {},
 *   listen: () => () => {},
 *   onClose: () => () => {},
 *   isOpen: () => true,
 * };
 * const link = PeerLink.make({ peer: "guest-1", lockstep: quiet, messages: quiet, closed: Effect.never });
 * link.peer; // => "guest-1"
 * link.toJSON(); // => { _id: "PeerLink", peer: "guest-1", lockstep: true, messages: true }
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface PeerLink extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  readonly peer: Transport.PeerId;
  /** Unreliable and unordered: a lockstep session's transport. */
  readonly lockstep: TextChannel;
  /** Reliable and ordered: what the app says around a run. */
  readonly messages: TextChannel;
  /** Succeeds once the link has closed. Never fails. */
  readonly closed: Effect.Effect<void>;
}

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: PeerLink) {
    return {
      _id: "PeerLink",
      peer: this.peer,
      lockstep: this.lockstep.isOpen(),
      messages: this.messages.isOpen(),
    };
  },
};

/**
 * Checks whether a value is a peer link.
 *
 * **When to use**
 *
 * Narrow an unknown value before sending on its channels.
 *
 * **Example** (Recognising a link)
 *
 * ```ts
 * import { PeerLink } from "arcadekit/net/browser";
 * import { Effect } from "effect";
 *
 * const quiet: PeerLink.TextChannel = {
 *   send: () => {},
 *   listen: () => () => {},
 *   onClose: () => () => {},
 *   isOpen: () => false,
 * };
 * const link = PeerLink.make({ peer: "host", lockstep: quiet, messages: quiet, closed: Effect.void });
 * PeerLink.isPeerLink(link); // => true
 * PeerLink.isPeerLink({ peer: "host" }); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isPeerLink = (value: unknown): value is PeerLink =>
  Predicate.hasProperty(value, TypeId);

/**
 * Makes a link from its peer, its two channels and the Effect that waits for it to close.
 *
 * **When to use**
 *
 * In a `PeerConnector` of the app's own, or in a test's stand-in for one: a connector gives the
 * link once both channels are open. The WebRTC connector (`RtcPeerConnector`) makes its own.
 *
 * **Details**
 *
 * `make` calls nothing: the link's channels are what it was given.
 *
 * **Example** (A link that is already closed)
 *
 * ```ts
 * import { PeerLink } from "arcadekit/net/browser";
 * import { Effect } from "effect";
 *
 * const shut: PeerLink.TextChannel = {
 *   send: () => {},
 *   listen: () => () => {},
 *   onClose: (handler) => {
 *     handler();
 *     return () => {};
 *   },
 *   isOpen: () => false,
 * };
 * const link = PeerLink.make({ peer: "host", lockstep: shut, messages: shut, closed: Effect.void });
 * Effect.runSync(link.closed); // => undefined
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = (
  fields: Pick<PeerLink, "peer" | "lockstep" | "messages" | "closed">
): PeerLink => {
  const self = Object.create(Proto) as Types.Mutable<PeerLink>;
  self.peer = fields.peer;
  self.lockstep = fields.lockstep;
  self.messages = fields.messages;
  self.closed = fields.closed;
  return self;
};
