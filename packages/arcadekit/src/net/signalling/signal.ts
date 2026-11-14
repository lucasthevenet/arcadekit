/**
 * Signals: what one peer's WebRTC connection makes for the other's, relayed by the signalling
 * worker until both ends are connected.
 *
 * A host's connection makes an offer, a guest's an answer, and both make ICE candidates; each is
 * a signal, sent to the worker in a `ClientMessage` and relayed in a `ServerMessage`. Every field
 * is bounded, so a forged signal can't make the worker relay more than a message holds. Plain on
 * purpose: a Schema.
 *
 * @since 0.7.0
 */
import { Schema } from "effect";

/**
 * The longest `sdpMid` or ICE username fragment a signal carries: ICE allows 256 characters.
 *
 * **When to use**
 *
 * Rarely: `Signal` refuses a longer one.
 *
 * **Example** (The longest token)
 *
 * ```ts
 * import { Signal } from "arcadekit/net/signalling";
 *
 * Signal.maxTokenLength; // => 256
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export const maxTokenLength = 256;

/** An SDP or an ICE candidate line: as long as fits in a message, `ClientMessage.maxLength`. */
const Sdp: Schema.String = Schema.String.check(Schema.isMaxLength(16 * 1024));

const Token: Schema.NullOr<Schema.String> = Schema.NullOr(
  Schema.String.check(Schema.isMaxLength(maxTokenLength))
);

const Offer: Schema.Struct<{
  readonly kind: Schema.Literal<"offer">;
  readonly sdp: Schema.String;
}> = Schema.Struct({ kind: Schema.Literal("offer"), sdp: Sdp });

const Answer: Schema.Struct<{
  readonly kind: Schema.Literal<"answer">;
  readonly sdp: Schema.String;
}> = Schema.Struct({ kind: Schema.Literal("answer"), sdp: Sdp });

/** `RTCIceCandidateInit`'s fields; `candidate: ""` is the end of candidates. */
const Candidate: Schema.Struct<{
  readonly kind: Schema.Literal<"candidate">;
  readonly candidate: Schema.String;
  readonly sdpMid: Schema.NullOr<Schema.String>;
  readonly sdpMLineIndex: Schema.NullOr<Schema.Int>;
  readonly usernameFragment: Schema.NullOr<Schema.String>;
}> = Schema.Struct({
  kind: Schema.Literal("candidate"),
  candidate: Sdp,
  sdpMid: Token,
  // An m-line's index, an unsigned short in WebRTC.
  sdpMLineIndex: Schema.NullOr(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_535 }))
  ),
  usernameFragment: Token,
});

/**
 * The Schema of one WebRTC signal: an offer, an answer or an ICE candidate, by `kind`.
 *
 * **When to use**
 *
 * To decode a signal that arrives from the network, as the protocol's messages do.
 *
 * **Details**
 *
 * An SDP or a candidate line is at most `ClientMessage.maxLength`, an `sdpMid` or a username
 * fragment at most `maxTokenLength`, and `sdpMLineIndex` is 0 to 65535.
 *
 * **Example** (An offer and a signal that is none)
 *
 * ```ts
 * import { Signal } from "arcadekit/net/signalling";
 * import { Schema } from "effect";
 *
 * Schema.is(Signal.Signal)({ kind: "offer", sdp: "v=0" }); // => true
 * Schema.is(Signal.Signal)({ kind: "hello" }); // => false
 * ```
 *
 * @category schemas
 * @since 0.7.0
 */
export const Signal: Schema.Union<
  readonly [typeof Offer, typeof Answer, typeof Candidate]
> = Schema.Union([Offer, Answer, Candidate]);

/**
 * One WebRTC signal: what `RTCPeerConnection` makes on one side and takes on the other.
 *
 * **When to use**
 *
 * To type what a peer connector sends and applies while it connects two peers.
 *
 * **Details**
 *
 * A candidate with `candidate: ""` is the end of candidates.
 *
 * **Example** (The end of candidates)
 *
 * ```ts
 * import type { Signal } from "arcadekit/net/signalling";
 *
 * const done: Signal.Signal = {
 *   kind: "candidate",
 *   candidate: "",
 *   sdpMid: null,
 *   sdpMLineIndex: null,
 *   usernameFragment: null,
 * };
 * done.kind; // => "candidate"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type Signal = typeof Signal.Type;
