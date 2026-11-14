import type { PeerId, ServerMessage } from "../../signalling/index";
import type { Room, RoomOutput } from "./room";

// Carries out a room's outputs on its sockets. Plain on purpose: each output is one
// synchronous call on a socket, which Effect would only wrap in `Effect.sync`, and a send or a
// close that throws is a socket already closing, whose close event tells the room, so there is no
// failure for a caller to handle. The Durable Object's Effects (connections.ts) call it, each in
// the event that brought what it carries out.

/** The part of a WebSocket the room needs. A Cloudflare `WebSocket` is one; tests pass a fake. */
export interface RoomSocket {
  readonly send: (text: string) => void;
  readonly close: (code: number, reason: string) => void;
}

/**
 * WebSocket close codes the worker uses: 1000 normal, 1011 the worker couldn't keep the socket,
 * 4000+ the protocol's own errors.
 */
export const CLOSE_NORMAL = 1000;
export const CLOSE_SERVER_ERROR = 1011;
export const CLOSE_PROTOCOL_ERROR = 4000;

/**
 * Carries out a `Room`'s outputs on sockets: the adapter between the room's rules and the
 * Durable Object's WebSockets. It keeps which socket is which peer, so the room deals in peer
 * ids only.
 */
export interface SocketRoom {
  /**
   * A socket was accepted for `role`. Returns the peer id the room gave it, or `undefined` if
   * the room refused it: then it has its error and is closed.
   */
  readonly open: (
    socket: RoomSocket,
    role: "host" | "guest",
    nowMs: number
  ) => PeerId.PeerId | undefined;
  readonly message: (socket: RoomSocket, text: string, nowMs: number) => void;
  /** The socket closed or errored. */
  readonly closed: (socket: RoomSocket) => void;
  /** The worker can't keep the socket: the room hears it leave, and it is closed with 1011. */
  readonly drop: (socket: RoomSocket) => void;
  /** The expiry alarm fired. */
  readonly alarm: (nowMs: number) => void;
}

export const makeSocketRoom = (room: Room): SocketRoom => {
  const sockets = new Map<PeerId.PeerId, RoomSocket>();
  const peers = new Map<RoomSocket, PeerId.PeerId>();

  const send = (socket: RoomSocket, message: ServerMessage.ServerMessage) => {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // The socket is already closing; its close event tells the room.
    }
  };

  const close = (socket: RoomSocket, code: number, reason: string) => {
    try {
      socket.close(code, reason);
    } catch {
      // Already closed.
    }
  };

  const carryOut = (outputs: readonly RoomOutput[]) => {
    // The reason a peer is closed for, so the close frame carries it too.
    const reasons = new Map<PeerId.PeerId, ServerMessage.ErrorReason>();
    for (const output of outputs) {
      const socket = sockets.get(
        output.kind === "send" ? output.to : output.peer
      );
      if (socket === undefined) {
        continue;
      }
      if (output.kind === "send") {
        if (output.message.type === "error") {
          reasons.set(output.to, output.message.reason);
        }
        send(socket, output.message);
      } else {
        sockets.delete(output.peer);
        peers.delete(socket);
        const reason = reasons.get(output.peer);
        if (reason === undefined) {
          close(socket, CLOSE_NORMAL, "done");
        } else {
          close(socket, CLOSE_PROTOCOL_ERROR, reason);
        }
      }
    }
  };

  const closed = (socket: RoomSocket) => {
    const peer = peers.get(socket);
    if (peer === undefined) {
      return;
    }
    sockets.delete(peer);
    peers.delete(socket);
    carryOut(room.leave(peer));
  };

  return {
    open: (socket, role, nowMs) => {
      // The alarm may not have run yet: close an expired room's sockets before refusing this one.
      carryOut(room.expire(nowMs));
      const admission = room.admit(role, nowMs);
      if (!admission.ok) {
        send(socket, { type: "error", reason: admission.reason });
        close(socket, CLOSE_PROTOCOL_ERROR, admission.reason);
        return;
      }
      sockets.set(admission.peer, socket);
      peers.set(socket, admission.peer);
      carryOut(admission.outputs);
      return admission.peer;
    },
    message: (socket, text, nowMs) => {
      const peer = peers.get(socket);
      if (peer !== undefined) {
        carryOut(room.receive(peer, text, nowMs));
      }
    },
    closed,
    drop: (socket) => {
      closed(socket);
      close(socket, CLOSE_SERVER_ERROR, "server error");
    },
    alarm: (nowMs) => carryOut(room.expire(nowMs)),
  };
};
