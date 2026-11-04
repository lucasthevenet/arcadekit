import {
  HOST_ID,
  MAX_PLAYERS,
  parseClientMessage,
  ROOM_TTL_MS,
} from "./protocol";
import type { ErrorReason, PeerId, ServerMessage } from "./protocol";

/**
 * What the room asks its Durable Object to do with sockets. The room never touches a socket, so
 * its rules are tested without Cloudflare; the Durable Object is the adapter that carries these
 * out on real WebSockets.
 */
export type RoomOutput =
  | {
      readonly kind: "send";
      readonly to: PeerId;
      readonly message: ServerMessage;
    }
  /** Close `peer`'s socket. The room has already forgotten it. */
  | { readonly kind: "close"; readonly peer: PeerId };

/** The answer to a socket that asks to enter the room. */
export type Admission =
  | {
      readonly ok: true;
      readonly peer: PeerId;
      readonly outputs: readonly RoomOutput[];
    }
  /** Send `{ type: "error", reason }` on the socket and close it; it never had a peer id. */
  | { readonly ok: false; readonly reason: ErrorReason };

/**
 * One join code's room: who is in it, whether the run has started, and when it expires. A host
 * opens it; up to `MAX_PLAYERS - 1` guests join; it ends when the host leaves or it expires,
 * and an ended room admits no one again.
 */
export interface Room {
  /**
   * A socket asks to enter as the host or as a guest. An expired room admits no one, but only
   * `expire` closes the sockets still in it.
   */
  readonly admit: (role: "host" | "guest", nowMs: number) => Admission;
  /** A text message arrived from `peer`. */
  readonly receive: (
    peer: PeerId,
    text: string,
    nowMs: number
  ) => readonly RoomOutput[];
  /** `peer`'s socket closed or failed. */
  readonly leave: (peer: PeerId) => readonly RoomOutput[];
  /** The expiry alarm fired; ends the room if its time is up. */
  readonly expire: (nowMs: number) => readonly RoomOutput[];
  /** When the room expires, or `undefined` before a host opens it. */
  readonly expiresAtMs: () => number | undefined;
  /** The peers in the room now, host first. */
  readonly peers: () => readonly PeerId[];
}

export interface RoomOptions {
  readonly maxPlayers?: number;
  readonly ttlMs?: number;
}

type Phase = "empty" | "open" | "started" | "ended";

export const createRoom = (code: string, options: RoomOptions = {}): Room => {
  const maxPlayers = options.maxPlayers ?? MAX_PLAYERS;
  const ttlMs = options.ttlMs ?? ROOM_TTL_MS;
  let phase: Phase = "empty";
  let expiresAt: number | undefined;
  let guestsSoFar = 0;
  // Host first, then guests in join order.
  const members: PeerId[] = [];

  const end = (reason: ErrorReason): RoomOutput[] => {
    phase = "ended";
    const outputs = members.flatMap((peer): RoomOutput[] => [
      { kind: "send", to: peer, message: { type: "error", reason } },
      { kind: "close", peer },
    ]);
    members.length = 0;
    return outputs;
  };

  const reject = (peer: PeerId, reason: ErrorReason): RoomOutput[] => [
    ...remove(peer),
    { kind: "send", to: peer, message: { type: "error", reason } },
    { kind: "close", peer },
  ];

  const remove = (peer: PeerId): RoomOutput[] => {
    const index = members.indexOf(peer);
    if (index === -1) {
      return [];
    }
    if (peer === HOST_ID) {
      members.splice(index, 1);
      return end("host-left");
    }
    members.splice(index, 1);
    return phase === "open"
      ? [{ kind: "send", to: HOST_ID, message: { type: "peer-left", peer } }]
      : [];
  };

  // In the star, a guest only ever talks to the host, so the host is the only peer it's told of.
  const welcome = (self: PeerId, peers: readonly PeerId[]): ServerMessage => ({
    type: "welcome",
    code,
    self,
    host: HOST_ID,
    peers,
  });

  const isExpired = (nowMs: number) =>
    expiresAt !== undefined && nowMs >= expiresAt;

  return {
    admit: (role, nowMs) => {
      // An expired room is over even before `expire` has closed its sockets.
      const over = phase === "ended" || isExpired(nowMs);
      if (role === "host") {
        if (phase !== "empty") {
          return { ok: false, reason: "code-taken" };
        }
        phase = "open";
        expiresAt = nowMs + ttlMs;
        members.push(HOST_ID);
        return {
          ok: true,
          peer: HOST_ID,
          outputs: [
            { kind: "send", to: HOST_ID, message: welcome(HOST_ID, []) },
          ],
        };
      }
      if (phase === "empty" || over) {
        return { ok: false, reason: "unknown-code" };
      }
      if (phase === "started") {
        return { ok: false, reason: "started" };
      }
      if (members.length >= maxPlayers) {
        return { ok: false, reason: "full" };
      }
      guestsSoFar += 1;
      const peer = `guest-${guestsSoFar}`;
      members.push(peer);
      return {
        ok: true,
        peer,
        outputs: [
          { kind: "send", to: peer, message: welcome(peer, [HOST_ID]) },
          {
            kind: "send",
            to: HOST_ID,
            message: { type: "peer-joined", peer },
          },
        ],
      };
    },

    receive: (peer, text, nowMs) => {
      if (!members.includes(peer)) {
        return [];
      }
      if (isExpired(nowMs)) {
        return end("expired");
      }
      const message = parseClientMessage(text);
      if (message === undefined) {
        return reject(peer, "bad-message");
      }
      switch (message.type) {
        case "start": {
          if (peer !== HOST_ID) {
            return reject(peer, "not-allowed");
          }
          phase = "started";
          return members.map((member): RoomOutput => ({
            kind: "send",
            to: member,
            message: { type: "started" },
          }));
        }
        case "signal": {
          // The star: the host signals any guest, a guest signals only the host.
          const allowed =
            message.to !== peer && (peer === HOST_ID || message.to === HOST_ID);
          if (!allowed) {
            return reject(peer, "not-allowed");
          }
          if (!members.includes(message.to)) {
            // The target just left; the host hears that through `peer-left`.
            return [];
          }
          return [
            {
              kind: "send",
              to: message.to,
              message: { type: "signal", from: peer, signal: message.signal },
            },
          ];
        }
      }
    },

    leave: (peer) => remove(peer),

    expire: (nowMs) =>
      phase !== "ended" && isExpired(nowMs) ? end("expired") : [],

    expiresAtMs: () => expiresAt,

    peers: () => [...members],
  };
};
