import {
  ClientMessage,
  PeerId,
  Room as RoomLimits,
} from "../../signalling/index";
import type { ServerMessage } from "../../signalling/index";

// One room's rules, plain on purpose (ADR-0024): inputs in, outputs out, and a refusal is a value.
// The Durable Object's Effects (connections.ts) carry the outputs out on its sockets.

/**
 * What the room asks its Durable Object to do with sockets. The room never touches a socket, so
 * its rules are tested without Cloudflare; the Durable Object is the adapter that carries these
 * out on real WebSockets.
 */
export type RoomOutput =
  | {
      readonly kind: "send";
      readonly to: PeerId.PeerId;
      readonly message: ServerMessage.ServerMessage;
    }
  /** Close `peer`'s socket. The room has already forgotten it. */
  | { readonly kind: "close"; readonly peer: PeerId.PeerId };

/** The answer to a socket that asks to enter the room. */
export type Admission =
  | {
      readonly ok: true;
      readonly peer: PeerId.PeerId;
      readonly outputs: readonly RoomOutput[];
    }
  /** Send `{ type: "error", reason }` on the socket and close it; it never had a peer id. */
  | { readonly ok: false; readonly reason: ServerMessage.ErrorReason };

/**
 * One join code's room: who is in it, whether the run has started, and when it expires. A host
 * opens it; guests join until it holds its room size; it ends when the host leaves or it expires,
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
    peer: PeerId.PeerId,
    text: string,
    nowMs: number
  ) => readonly RoomOutput[];
  /** `peer`'s socket closed or failed. */
  readonly leave: (peer: PeerId.PeerId) => readonly RoomOutput[];
  /** The expiry alarm fired; ends the room if its time is up. */
  readonly expire: (nowMs: number) => readonly RoomOutput[];
  /** When the room expires, or `undefined` before a host opens it. */
  readonly expiresAtMs: () => number | undefined;
  /** The peers in the room now, host first. */
  readonly peers: () => readonly PeerId.PeerId[];
}

export interface RoomOptions {
  /**
   * The most players the room holds, host included: a whole number from 2 to `Room.maxSize`.
   * `Room.defaultSize` if left out.
   */
  readonly roomSize?: number;
  readonly ttlMs?: number;
}

/**
 * `roomSize` if a room can have that size, or `Room.defaultSize` if it is left out. Any other
 * size throws: it is a mistake in the worker's setup, so it is refused there, not changed to a
 * size the app didn't ask for.
 */
export const checkRoomSize = (
  roomSize: number = RoomLimits.defaultSize
): number => {
  if (
    !Number.isInteger(roomSize) ||
    roomSize < 2 ||
    roomSize > RoomLimits.maxSize
  ) {
    throw new RangeError(
      `A signalling room holds 2 to ${RoomLimits.maxSize} players, not ${roomSize}`
    );
  }
  return roomSize;
};

type Phase = "empty" | "open" | "started" | "ended";

export const makeRoom = (code: string, options: RoomOptions = {}): Room => {
  const roomSize = checkRoomSize(options.roomSize);
  const ttlMs = options.ttlMs ?? RoomLimits.ttlMs;
  let phase: Phase = "empty";
  let expiresAt: number | undefined;
  let guestsSoFar = 0;
  // Host first, then guests in join order.
  const members: PeerId.PeerId[] = [];

  const end = (reason: ServerMessage.ErrorReason): RoomOutput[] => {
    phase = "ended";
    const outputs = members.flatMap((peer): RoomOutput[] => [
      { kind: "send", to: peer, message: { type: "error", reason } },
      { kind: "close", peer },
    ]);
    members.length = 0;
    return outputs;
  };

  const reject = (
    peer: PeerId.PeerId,
    reason: ServerMessage.ErrorReason
  ): RoomOutput[] => [
    ...remove(peer),
    { kind: "send", to: peer, message: { type: "error", reason } },
    { kind: "close", peer },
  ];

  const remove = (peer: PeerId.PeerId): RoomOutput[] => {
    const index = members.indexOf(peer);
    if (index === -1) {
      return [];
    }
    if (peer === PeerId.host) {
      members.splice(index, 1);
      if (phase === "started") {
        // The run goes on over the data channels; a guest's socket closing late isn't an error.
        phase = "ended";
        const outputs = members.map((member): RoomOutput => ({
          kind: "close",
          peer: member,
        }));
        members.length = 0;
        return outputs;
      }
      return end("host-left");
    }
    members.splice(index, 1);
    return phase === "open"
      ? [
          {
            kind: "send",
            to: PeerId.host,
            message: { type: "peer-left", peer },
          },
        ]
      : [];
  };

  // In the star, a guest only ever talks to the host, so the host is the only peer it's told of.
  const welcome = (
    self: PeerId.PeerId,
    peers: readonly PeerId.PeerId[]
  ): ServerMessage.ServerMessage => ({
    type: "welcome",
    code,
    self,
    host: PeerId.host,
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
        members.push(PeerId.host);
        return {
          ok: true,
          peer: PeerId.host,
          outputs: [
            {
              kind: "send",
              to: PeerId.host,
              message: welcome(PeerId.host, []),
            },
          ],
        };
      }
      if (phase === "empty" || over) {
        return { ok: false, reason: "unknown-code" };
      }
      if (phase === "started") {
        return { ok: false, reason: "started" };
      }
      if (members.length >= roomSize) {
        return { ok: false, reason: "full" };
      }
      guestsSoFar += 1;
      const peer = `guest-${guestsSoFar}`;
      members.push(peer);
      return {
        ok: true,
        peer,
        outputs: [
          { kind: "send", to: peer, message: welcome(peer, [PeerId.host]) },
          {
            kind: "send",
            to: PeerId.host,
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
      const message = ClientMessage.fromJson(text);
      if (message === undefined) {
        return reject(peer, "bad-message");
      }
      switch (message.type) {
        case "start": {
          if (peer !== PeerId.host) {
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
            message.to !== peer &&
            (peer === PeerId.host || message.to === PeerId.host);
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
