import { Option, Schema } from "effect";

/**
 * The signalling protocol: the JSON messages a lockstep run's peers and the signalling worker
 * exchange over one WebSocket each, while the peers set up their WebRTC connections (#25,
 * ADR-0012). It is the interface between the worker (the survivors demo's, in
 * `apps/survivor-demo/worker`) and the browser's signalling client (`hostRoom`, `joinRoom` in
 * `@arcadekit/net/browser`), exported as `@arcadekit/net/signalling`, so it has no DOM and needs
 * nothing but `effect`.
 *
 * A host opens `wss://<worker>/host` and is told its join code in `welcome`. Each guest opens
 * `wss://<worker>/join/<code>`. In the host star, the host signals every guest and each guest
 * signals only the host: the worker relays `signal` messages between them and tells the host
 * who joined and left. Once every data channel is open, the host sends `start`, which closes
 * the room to new guests (there is no late join), and the peers close their sockets.
 *
 * Each message is an Effect Schema, and its type is the Schema's. The Schemas transform nothing,
 * so a message on the wire is `JSON.stringify` of its type; `parseClientMessage` and
 * `parseServerMessage` read one back.
 */

/** The most players a room holds, host included (ADR-0012: 2 to 4 players). */
export const MAX_PLAYERS = 4;

/** How long a room lives after its host connects. Signalling takes seconds; this is generous. */
export const ROOM_TTL_MS: number = 10 * 60 * 1000;

/** The longest message the worker relays. An SDP offer is a few kilobytes. */
export const MAX_MESSAGE_LENGTH: number = 16 * 1024;

/** The letters a join code uses: no 0/O, 1/I/L, so it can be read aloud and typed. */
export const JOIN_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** How many letters a join code has. 31^6 is about 900 million codes. */
export const JOIN_CODE_LENGTH = 6;

/** The longest peer id. The worker's are `host` and `guest-<n>`. */
const MAX_PEER_ID_LENGTH = 32;

/** The longest `sdpMid` or ICE username fragment: ICE allows 256 characters. */
const MAX_TOKEN_LENGTH = 256;

/** A peer's id within one room: `host`, or `guest-1`, `guest-2`, … in join order, never reused. */
export const PeerId: Schema.String = Schema.String.check(
  Schema.isMaxLength(MAX_PEER_ID_LENGTH)
);
export type PeerId = typeof PeerId.Type;

/** The host's peer id in every room. */
export const HOST_ID: PeerId = "host";

/** A join code: `JOIN_CODE_LENGTH` letters of `JOIN_CODE_ALPHABET`. */
export const JoinCode: Schema.String = Schema.String.check(
  Schema.isPattern(
    new RegExp(`^[${JOIN_CODE_ALPHABET}]{${JOIN_CODE_LENGTH}}$`, "u")
  )
);

/** An SDP or an ICE candidate line: as long as fits in a message. */
const Sdp: Schema.String = Schema.String.check(
  Schema.isMaxLength(MAX_MESSAGE_LENGTH)
);

const Token: Schema.NullOr<Schema.String> = Schema.NullOr(
  Schema.String.check(Schema.isMaxLength(MAX_TOKEN_LENGTH))
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

/** One WebRTC signal: what `RTCPeerConnection` produces on one side and consumes on the other. */
export const Signal: Schema.Union<
  readonly [typeof Offer, typeof Answer, typeof Candidate]
> = Schema.Union([Offer, Answer, Candidate]);
export type Signal = typeof Signal.Type;

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

/** What a peer sends the worker. */
export const ClientMessage: Schema.Union<
  readonly [typeof SignalRequest, typeof Start]
> = Schema.Union([SignalRequest, Start]);
export type ClientMessage = typeof ClientMessage.Type;

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
 * Why the worker turned a peer away or ended its room. Each one closes the socket.
 *
 * - `unknown-code`: no room has this code: it was never opened, its host left, or it expired.
 * - `code-taken`: a host asked for a code that is already in use. Ask again for a new one.
 * - `full`: the room already holds `MAX_PLAYERS` players.
 * - `started`: the host has started the run; there is no late join.
 * - `expired`: the room outlived `ROOM_TTL_MS`.
 * - `host-left`: the host left before the start, so the room is gone. After the start, the
 *   guests' sockets just close (1000).
 * - `bad-message`: a message that isn't valid JSON for this protocol, or is too long.
 * - `not-allowed`: a valid message this peer may not send (a guest signalling a guest, a guest
 *   starting).
 */
export const ErrorReason: Schema.Literals<typeof ERROR_REASONS> =
  Schema.Literals(ERROR_REASONS);
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
  peers: Schema.Array(PeerId).check(Schema.isMaxLength(MAX_PLAYERS - 1)),
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

/** What the worker sends a peer. */
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
export type ServerMessage = typeof ServerMessage.Type;

/**
 * Makes a join code from random bytes, such as `crypto.getRandomValues(new Uint8Array(32))`.
 * Bytes the alphabet doesn't divide evenly are skipped, so every code is equally likely; returns
 * `undefined` in the unlikely case the bytes run out first.
 */
export const joinCodeFromBytes = (
  bytes: ArrayLike<number>
): string | undefined => {
  const size = JOIN_CODE_ALPHABET.length;
  const limit = Math.floor(256 / size) * size;
  let code = "";
  for (let i = 0; i < bytes.length && code.length < JOIN_CODE_LENGTH; i++) {
    const byte = bytes[i]!;
    if (byte < limit) {
      code += JOIN_CODE_ALPHABET[byte % size];
    }
  }
  return code.length === JOIN_CODE_LENGTH ? code : undefined;
};

const isJoinCode = Schema.is(JoinCode);

/** A join code as a person typed it, upper-cased and trimmed; `undefined` if it can't be one. */
export const normalizeJoinCode = (typed: string): string | undefined => {
  const code = typed.trim().toUpperCase();
  return isJoinCode(code) ? code : undefined;
};

/**
 * The join code in a guest's `/join/<code>` path, normalized; `undefined` for any other path, a
 * malformed escape or a code that can't be one. The worker and the local server route by it.
 */
export const joinCodeFromPath = (pathname: string): string | undefined => {
  const match = /^\/join\/(?<code>[^/]+)$/u.exec(pathname);
  if (match === null) {
    return undefined;
  }
  try {
    return normalizeJoinCode(decodeURIComponent(match.groups!.code!));
  } catch {
    return undefined;
  }
};

const decodeClientMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(ClientMessage)
);

const decodeServerMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(ServerMessage)
);

/**
 * Reads a peer's message; `undefined` when it isn't valid for this protocol or is longer than
 * `MAX_MESSAGE_LENGTH`.
 */
export const parseClientMessage = (text: string): ClientMessage | undefined =>
  text.length > MAX_MESSAGE_LENGTH
    ? undefined
    : Option.getOrUndefined(decodeClientMessage(text));

/** Reads the worker's message; `undefined` when it isn't valid for this protocol. */
export const parseServerMessage = (text: string): ServerMessage | undefined =>
  Option.getOrUndefined(decodeServerMessage(text));
