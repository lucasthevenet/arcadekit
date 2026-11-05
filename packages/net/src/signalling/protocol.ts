/**
 * The signalling protocol: the JSON messages a lockstep run's peers and the signalling worker
 * exchange over one WebSocket each, while the peers set up their WebRTC connections (#25,
 * ADR-0012). It is the interface between the worker (the survivors demo's, in
 * `apps/survivor-demo/worker`) and the browser's signalling client (`hostRoom`, `joinRoom` in
 * `@arcadekit/net/browser`), exported as `@arcadekit/net/signalling`, so it has no dependencies and
 * no DOM.
 *
 * A host opens `wss://<worker>/host` and is told its join code in `welcome`. Each guest opens
 * `wss://<worker>/join/<code>`. In the host star, the host signals every guest and each guest
 * signals only the host: the worker relays `signal` messages between them and tells the host
 * who joined and left. Once every data channel is open, the host sends `start`, which closes
 * the room to new guests (there is no late join), and the peers close their sockets.
 */

/** A peer's id within one room: `host`, or `guest-1`, `guest-2`, … in join order, never reused. */
export type PeerId = string;

/** The host's peer id in every room. */
export const HOST_ID: PeerId = "host";

/** The most players a room holds, host included (ADR-0012: 2 to 4 players). */
export const MAX_PLAYERS = 4;

/** How long a room lives after its host connects. Signalling takes seconds; this is generous. */
export const ROOM_TTL_MS: number = 10 * 60 * 1000;

/** The longest message the worker relays. An SDP offer is a few kilobytes. */
export const MAX_MESSAGE_LENGTH: number = 16 * 1024;

/** One WebRTC signal: what `RTCPeerConnection` produces on one side and consumes on the other. */
export type Signal =
  | { readonly kind: "offer"; readonly sdp: string }
  | { readonly kind: "answer"; readonly sdp: string }
  | {
      readonly kind: "candidate";
      /** `RTCIceCandidateInit`'s fields; `candidate: ""` is the end of candidates. */
      readonly candidate: string;
      readonly sdpMid: string | null;
      readonly sdpMLineIndex: number | null;
      readonly usernameFragment: string | null;
    };

/** What a peer sends the worker. */
export type ClientMessage =
  /** Relay `signal` to peer `to`. A guest may only signal the host. */
  | { readonly type: "signal"; readonly to: PeerId; readonly signal: Signal }
  /** Host only: the run is starting, so no one else may join. */
  | { readonly type: "start" };

/** Why the worker turned a peer away or ended its room. Each one closes the socket. */
export type ErrorReason =
  /** No room has this code: it was never opened, its host left, or it expired. */
  | "unknown-code"
  /** A host asked for a code that is already in use. Ask again for a new one. */
  | "code-taken"
  /** The room already holds `MAX_PLAYERS` players. */
  | "full"
  /** The host has started the run; there is no late join. */
  | "started"
  /** The room outlived `ROOM_TTL_MS`. */
  | "expired"
  /** The host left before the start, so the room is gone. After the start, the guests' sockets just close (1000). */
  | "host-left"
  /** A message that isn't valid JSON for this protocol, or is too long. */
  | "bad-message"
  /** A valid message this peer may not send (a guest signalling a guest, a guest starting). */
  | "not-allowed";

/** What the worker sends a peer. */
export type ServerMessage =
  /**
   * The first message on a socket. `peers` is everyone else in the room: the guests so far for
   * the host, and just the host for a guest.
   */
  | {
      readonly type: "welcome";
      readonly code: string;
      readonly self: PeerId;
      readonly host: PeerId;
      readonly peers: readonly PeerId[];
    }
  /** To the host: a guest joined. The host makes the offer. */
  | { readonly type: "peer-joined"; readonly peer: PeerId }
  /** To the host: a guest's socket closed before the run started. */
  | { readonly type: "peer-left"; readonly peer: PeerId }
  /** A signal relayed from `from`. */
  | { readonly type: "signal"; readonly from: PeerId; readonly signal: Signal }
  /** To every peer: the host started the run. */
  | { readonly type: "started" }
  /** The last message before the worker closes the socket. */
  | { readonly type: "error"; readonly reason: ErrorReason };

/** The letters a join code uses: no 0/O, 1/I/L, so it can be read aloud and typed. */
export const JOIN_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** How many letters a join code has. 31^6 is about 900 million codes. */
export const JOIN_CODE_LENGTH = 6;

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

/** A join code as a person typed it, upper-cased and trimmed; `undefined` if it can't be one. */
export const normalizeJoinCode = (typed: string): string | undefined => {
  const code = typed.trim().toUpperCase();
  if (code.length !== JOIN_CODE_LENGTH) {
    return undefined;
  }
  for (const letter of code) {
    if (!JOIN_CODE_ALPHABET.includes(letter)) {
      return undefined;
    }
  }
  return code;
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

/** Reads a peer's message; `undefined` when it isn't valid for this protocol. */
export const parseClientMessage = (text: string): ClientMessage | undefined => {
  if (text.length > MAX_MESSAGE_LENGTH) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.type === "start") {
    return { type: "start" };
  }
  if (value.type === "signal" && typeof value.to === "string") {
    const signal = parseSignal(value.signal);
    return signal === undefined
      ? undefined
      : { type: "signal", to: value.to, signal };
  }
  return undefined;
};

/** Reads the worker's message; `undefined` when it isn't valid for this protocol. */
export const parseServerMessage = (text: string): ServerMessage | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  switch (value.type) {
    case "welcome": {
      const { code, self, host, peers } = value;
      return typeof code === "string" &&
        typeof self === "string" &&
        typeof host === "string" &&
        Array.isArray(peers) &&
        peers.every((peer) => typeof peer === "string")
        ? { type: "welcome", code, self, host, peers }
        : undefined;
    }
    case "peer-joined":
    case "peer-left": {
      return typeof value.peer === "string"
        ? { type: value.type, peer: value.peer }
        : undefined;
    }
    case "signal": {
      const signal = parseSignal(value.signal);
      return typeof value.from === "string" && signal !== undefined
        ? { type: "signal", from: value.from, signal }
        : undefined;
    }
    case "started": {
      return { type: "started" };
    }
    case "error": {
      return isErrorReason(value.reason)
        ? { type: "error", reason: value.reason }
        : undefined;
    }
    default: {
      return undefined;
    }
  }
};

const ERROR_REASONS: ReadonlySet<string> = new Set<ErrorReason>([
  "unknown-code",
  "code-taken",
  "full",
  "started",
  "expired",
  "host-left",
  "bad-message",
  "not-allowed",
]);

const isErrorReason = (value: unknown): value is ErrorReason =>
  typeof value === "string" && ERROR_REASONS.has(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const parseSignal = (value: unknown): Signal | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    (value.kind === "offer" || value.kind === "answer") &&
    typeof value.sdp === "string"
  ) {
    return { kind: value.kind, sdp: value.sdp };
  }
  if (
    value.kind === "candidate" &&
    typeof value.candidate === "string" &&
    isStringOrNull(value.sdpMid) &&
    (value.sdpMLineIndex === null || Number.isInteger(value.sdpMLineIndex)) &&
    isStringOrNull(value.usernameFragment)
  ) {
    return {
      kind: "candidate",
      candidate: value.candidate,
      sdpMid: value.sdpMid,
      sdpMLineIndex: value.sdpMLineIndex as number | null,
      usernameFragment: value.usernameFragment,
    };
  }
  return undefined;
};
