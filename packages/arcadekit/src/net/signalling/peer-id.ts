/**
 * Peer ids: a peer's id within one signalling room, as the worker gives it.
 *
 * The host is `host`, and each guest `guest-1`, `guest-2` and so on in join order, never reused.
 * The ids are a lockstep run's peer ids too, so a run's player order is the room's. Plain on
 * purpose (ADR-0024): a Schema and its constants.
 *
 * @since 0.7.0
 */
import { Schema } from "effect";

/**
 * The longest peer id the protocol carries. The worker's are `host` and `guest-<n>`.
 *
 * **When to use**
 *
 * Rarely: `PeerId` refuses a longer one.
 *
 * **Example** (The longest id)
 *
 * ```ts
 * import { PeerId } from "arcadekit/net/signalling";
 *
 * PeerId.maxLength; // => 32
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export const maxLength = 32;

/**
 * The Schema of a peer's id within one room: a string of at most `maxLength` characters.
 *
 * **When to use**
 *
 * To decode a peer id that arrives from the network, as the protocol's messages do.
 *
 * **Example** (Decoding a peer id)
 *
 * ```ts
 * import { PeerId } from "arcadekit/net/signalling";
 * import { Schema } from "effect";
 *
 * Schema.is(PeerId.PeerId)("guest-1"); // => true
 * Schema.is(PeerId.PeerId)("x".repeat(33)); // => false
 * ```
 *
 * @category schemas
 * @since 0.7.0
 */
export const PeerId: Schema.String = Schema.String.check(
  Schema.isMaxLength(maxLength)
);

/**
 * A peer's id within one room: `host`, or `guest-1`, `guest-2`, … in join order, never reused.
 *
 * **When to use**
 *
 * To name a peer in what a room or a run reports.
 *
 * **Example** (A guest's id)
 *
 * ```ts
 * import type { PeerId } from "arcadekit/net/signalling";
 *
 * const first: PeerId.PeerId = "guest-1";
 * first.startsWith("guest-"); // => true
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type PeerId = typeof PeerId.Type;

/**
 * The host's peer id, in every room.
 *
 * **When to use**
 *
 * To tell the host from a guest, or to address the host.
 *
 * **Example** (The host's id)
 *
 * ```ts
 * import { PeerId } from "arcadekit/net/signalling";
 *
 * PeerId.host; // => "host"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export const host: PeerId = "host";
