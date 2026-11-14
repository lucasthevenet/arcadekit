/**
 * Server messages: what the signalling worker sends a peer over its WebSocket.
 *
 * The worker welcomes a peer with its join code and its id, tells the host who joined and left,
 * relays signals, confirms the start, and says why it turned a peer away or ended its room. Each
 * message is JSON of its Schema's type, which transforms nothing, so a message on the wire is
 * `JSON.stringify` of its value; `fromJson` reads one back. What arrives at a peer is untrusted,
 * so it is decoded where it arrives. Plain on purpose: a Schema and the data work that
 * reads it.
 *
 * @since 0.7.0
 */
import { Option, Schema } from "effect";

import { JoinCode } from "./join-code";
import { PeerId } from "./peer-id";
import { maxSize } from "./room";
import { Signal } from "./signal";

const ERROR_REASONS = [
  "unknown-code",
  "code-taken",
  "full",
  "started",
  "expired",
  "host-left",
  "bad-message",
  "not-allowed",
] as const;

/**
 * The Schema of why the worker turned a peer away or ended its room.
 *
 * **When to use**
 *
 * To decode a reason that arrives in an `error` message.
 *
 * **Example** (A reason and one that is none)
 *
 * ```ts
 * import { ServerMessage } from "arcadekit/net/signalling";
 * import { Schema } from "effect";
 *
 * Schema.is(ServerMessage.ErrorReason)("full"); // => true
 * Schema.is(ServerMessage.ErrorReason)("busy"); // => false
 * ```
 *
 * @category schemas
 * @since 0.7.0
 */
export const ErrorReason: Schema.Literals<typeof ERROR_REASONS> =
  Schema.Literals(ERROR_REASONS);

/**
 * Why the worker turned a peer away or ended its room. Each one closes the socket.
 *
 * - `unknown-code`: no room has this code: it was never opened, its host left, or it expired.
 * - `code-taken`: a host asked for a code that is already in use. Ask again for a new one.
 * - `full`: the room already holds as many players as the worker's room size.
 * - `started`: the host has started the run; there is no late join.
 * - `expired`: the room outlived `Room.ttlMs`.
 * - `host-left`: the host left before the start, so the room is gone. After the start, the
 *   guests' sockets just close (1000).
 * - `bad-message`: a message that isn't valid JSON for this protocol, or is too long.
 * - `not-allowed`: a valid message this peer may not send (a guest signalling a guest, a guest
 *   starting).
 *
 * **When to use**
 *
 * To say why a room failed, in the app's own words.
 *
 * **Example** (A reason in a player's words)
 *
 * ```ts
 * import type { ServerMessage } from "arcadekit/net/signalling";
 *
 * const say = (reason: ServerMessage.ErrorReason) =>
 *   reason === "full" ? "That room is full." : "Try again.";
 * say("full"); // => "That room is full."
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type ErrorReason = typeof ErrorReason.Type;

/**
 * The first message on a socket. `peers` is everyone else in the room: the guests so far for
 * the host, and just the host for a guest.
 */
const Welcome: Schema.Struct<{
  readonly type: Schema.Literal<"welcome">;
  readonly code: Schema.String;
  readonly self: Schema.String;
  readonly host: Schema.String;
  readonly peers: Schema.$Array<Schema.String>;
}> = Schema.Struct({
  type: Schema.Literal("welcome"),
  code: JoinCode,
  self: PeerId,
  host: PeerId,
  peers: Schema.Array(PeerId).check(Schema.isMaxLength(maxSize - 1)),
});

/** To the host: a guest joined. The host makes the offer. */
const PeerJoined: Schema.Struct<{
  readonly type: Schema.Literal<"peer-joined">;
  readonly peer: Schema.String;
}> = Schema.Struct({ type: Schema.Literal("peer-joined"), peer: PeerId });

/** To the host: a guest's socket closed before the run started. */
const PeerLeft: Schema.Struct<{
  readonly type: Schema.Literal<"peer-left">;
  readonly peer: Schema.String;
}> = Schema.Struct({ type: Schema.Literal("peer-left"), peer: PeerId });

/** A signal relayed from `from`. */
const RelayedSignal: Schema.Struct<{
  readonly type: Schema.Literal<"signal">;
  readonly from: Schema.String;
  readonly signal: typeof Signal;
}> = Schema.Struct({
  type: Schema.Literal("signal"),
  from: PeerId,
  signal: Signal,
});

/** To every peer: the host started the run. */
const Started: Schema.Struct<{ readonly type: Schema.Literal<"started"> }> =
  Schema.Struct({ type: Schema.Literal("started") });

/** The last message before the worker closes the socket. */
const Refusal: Schema.Struct<{
  readonly type: Schema.Literal<"error">;
  readonly reason: typeof ErrorReason;
}> = Schema.Struct({ type: Schema.Literal("error"), reason: ErrorReason });

/**
 * The Schema of what the worker sends a peer, by `type`.
 *
 * **When to use**
 *
 * To check a message before sending it, as the worker does, or to decode one in a client of the
 * app's own.
 *
 * **Example** (A welcome and a message that is none)
 *
 * ```ts
 * import { ServerMessage } from "arcadekit/net/signalling";
 * import { Schema } from "effect";
 *
 * const welcome = { type: "welcome", code: "K7MQ2X", self: "host", host: "host", peers: [] };
 * Schema.is(ServerMessage.ServerMessage)(welcome); // => true
 * Schema.is(ServerMessage.ServerMessage)({ type: "welcome" }); // => false
 * ```
 *
 * @category schemas
 * @since 0.7.0
 */
export const ServerMessage: Schema.Union<
  readonly [
    typeof Welcome,
    typeof PeerJoined,
    typeof PeerLeft,
    typeof RelayedSignal,
    typeof Started,
    typeof Refusal,
  ]
> = Schema.Union([
  Welcome,
  PeerJoined,
  PeerLeft,
  RelayedSignal,
  Started,
  Refusal,
]);

/**
 * What the worker sends a peer, by `type`:
 *
 * - `welcome`, the first: the room's join `code`, this peer's id (`self`), the `host`'s, and the
 *   other `peers` so far.
 * - `peer-joined` and `peer-left`, to the host: a guest's socket joined, or closed before the
 *   start.
 * - `signal`: a signal relayed from peer `from`.
 * - `started`, to every peer: the host started the run, and the room admits no one else.
 * - `error`: why the worker turned this peer away or ended its room, before it closes the socket.
 *
 * **When to use**
 *
 * To type what a signalling client hears.
 *
 * **Example** (Telling a refusal from the rest)
 *
 * ```ts
 * import type { ServerMessage } from "arcadekit/net/signalling";
 *
 * const refused = (message: ServerMessage.ServerMessage) => message.type === "error";
 * refused({ type: "error", reason: "full" }); // => true
 * refused({ type: "started" }); // => false
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type ServerMessage = typeof ServerMessage.Type;

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(ServerMessage));

/**
 * Reads the worker's message from the JSON text a socket carried, or `undefined` when it isn't
 * valid for this protocol.
 *
 * **When to use**
 *
 * Where the worker's message arrives: the browser's signalling client reads each so, and fails a
 * room with `bad-server-message` on one it can't read.
 *
 * **Example** (A start, and text from another version)
 *
 * ```ts
 * import { ServerMessage } from "arcadekit/net/signalling";
 *
 * ServerMessage.fromJson('{"type":"started"}'); // => { type: "started" }
 * ServerMessage.fromJson('{"type":"go"}'); // => undefined
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const fromJson = (text: string): ServerMessage | undefined =>
  Option.getOrUndefined(decode(text));
