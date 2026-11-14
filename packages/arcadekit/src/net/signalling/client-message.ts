/**
 * Client messages: what a peer sends the signalling worker over its WebSocket.
 *
 * A peer sends signals for the other end of each connection it is making, and the host sends the
 * start. Each message is JSON of its Schema's type, which transforms nothing, so a message on the
 * wire is `JSON.stringify` of its value; `fromJson` reads one back. What arrives at the worker is
 * untrusted, so it is decoded where it arrives. Plain on purpose: a Schema and the
 * data work that reads it.
 *
 * @since 0.7.0
 */
import { Option, Schema } from "effect";

import { PeerId } from "./peer-id";
import { Signal } from "./signal";

/**
 * The longest message the worker relays, in characters. An SDP offer is a few kilobytes.
 *
 * **When to use**
 *
 * Rarely: `fromJson` refuses a longer one, and the worker answers it `bad-message`.
 *
 * **Example** (The longest message)
 *
 * ```ts
 * import { ClientMessage } from "arcadekit/net/signalling";
 *
 * ClientMessage.maxLength; // => 16384
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export const maxLength: number = 16 * 1024;

/** Relay `signal` to peer `to`. A guest may only signal the host. */
const SignalRequest: Schema.Struct<{
  readonly type: Schema.Literal<"signal">;
  readonly to: Schema.String;
  readonly signal: typeof Signal;
}> = Schema.Struct({
  type: Schema.Literal("signal"),
  to: PeerId,
  signal: Signal,
});

/** Host only: the run is starting, so no one else may join. */
const Start: Schema.Struct<{ readonly type: Schema.Literal<"start"> }> =
  Schema.Struct({ type: Schema.Literal("start") });

/**
 * The Schema of what a peer sends the worker, by `type`: a `signal` for another peer, or the
 * host's `start`.
 *
 * **When to use**
 *
 * To check a message before sending it, or to decode one in a server of the app's own.
 *
 * **Example** (A signal for the host)
 *
 * ```ts
 * import { ClientMessage } from "arcadekit/net/signalling";
 * import { Schema } from "effect";
 *
 * const offer = { type: "signal", to: "host", signal: { kind: "offer", sdp: "v=0" } };
 * Schema.is(ClientMessage.ClientMessage)(offer); // => true
 * Schema.is(ClientMessage.ClientMessage)({ type: "kick" }); // => false
 * ```
 *
 * @category schemas
 * @since 0.7.0
 */
export const ClientMessage: Schema.Union<
  readonly [typeof SignalRequest, typeof Start]
> = Schema.Union([SignalRequest, Start]);

/**
 * What a peer sends the worker: `{ type: "signal", to, signal }` to relay a signal to peer `to`,
 * or the host's `{ type: "start" }`, which closes the room to new guests.
 *
 * **When to use**
 *
 * To type what a signalling client sends.
 *
 * **Details**
 *
 * In the host star a guest may signal only the host, and only the host may start: the worker
 * answers anything else `not-allowed`.
 *
 * **Example** (The host's start, on the wire)
 *
 * ```ts
 * import type { ClientMessage } from "arcadekit/net/signalling";
 *
 * const start: ClientMessage.ClientMessage = { type: "start" };
 * JSON.stringify(start); // => '{"type":"start"}'
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type ClientMessage = typeof ClientMessage.Type;

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(ClientMessage));

/**
 * Reads a peer's message from the JSON text its socket carried, or `undefined` when it isn't
 * valid for this protocol or is longer than `maxLength`.
 *
 * **When to use**
 *
 * Where a peer's message arrives: the signalling worker reads each so.
 *
 * **Example** (A start, and a message that is too long)
 *
 * ```ts
 * import { ClientMessage } from "arcadekit/net/signalling";
 *
 * ClientMessage.fromJson('{"type":"start"}'); // => { type: "start" }
 * ClientMessage.fromJson(" ".repeat(ClientMessage.maxLength + 1)); // => undefined
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const fromJson = (text: string): ClientMessage | undefined =>
  text.length > maxLength ? undefined : Option.getOrUndefined(decode(text));
