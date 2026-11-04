import {
  HOST_ID,
  normalizeJoinCode,
  parseServerMessage,
} from "../signalling/protocol";
import type {
  ClientMessage,
  ErrorReason,
  Signal,
} from "../signalling/protocol";
import type { PeerId } from "../transport";
import type { PeerLink } from "./channel";
import { rtcConnectPeer } from "./rtc";
import type { ConnectPeer, PeerConnecting, RtcOptions } from "./rtc";

/** Why a room failed: the worker's reasons, and the client's own. */
export type RoomFailure =
  | ErrorReason
  /** The signalling server couldn't be reached. */
  | "unreachable"
  /** The connection to the signalling server dropped before the start. */
  | "lost"
  /** The typed join code can't be one. */
  | "bad-code"
  /** A guest couldn't open its WebRTC connection to the host. */
  | "peer-failed";

/**
 * What a room reports, in order. A host hears `peer-joined` when a guest's socket joins, then
 * `peer-connected` once its data channels are open, or `peer-left` if it leaves or can't connect
 * before the start. A guest hears `peer-connected` once for the host.
 */
export type RoomEvent =
  | { readonly type: "welcome"; readonly code: string; readonly self: PeerId }
  | { readonly type: "peer-joined"; readonly peer: PeerId }
  | {
      readonly type: "peer-connected";
      readonly peer: PeerId;
      readonly link: PeerLink;
    }
  | {
      readonly type: "peer-left";
      readonly peer: PeerId;
      /** Why, when its connection failed rather than it leaving. */
      readonly reason?: string;
    }
  | { readonly type: "started" }
  | {
      readonly type: "failed";
      readonly reason: RoomFailure;
      readonly message: string;
    };

/**
 * - `connecting`: waiting for the worker's welcome.
 * - `open`: in the lobby; guests come and go.
 * - `started`: the host started; the room admits no one, the socket is closed and the links
 *   carry the run.
 * - `failed`: see the `failed` event. Every link is closed.
 * - `closed`: `close` was called.
 */
export type RoomStatus =
  | "connecting"
  | "open"
  | "started"
  | "failed"
  | "closed";

/**
 * One peer's side of a signalling room (#25, ADR-0012): its socket to the signalling worker and
 * the WebRTC links it makes through it. A host links to every guest; a guest only to the host.
 * Once the host starts, the links are the run's: `linksTransport(room.self, room.links())`
 * carries a lockstep session's messages.
 */
export interface SignallingRoom {
  readonly role: "host" | "guest";
  readonly status: RoomStatus;
  /** The join code, once welcomed. */
  readonly code: string | undefined;
  /** This peer's id in the room (`host`, `guest-1`, …), once welcomed. */
  readonly self: PeerId | undefined;
  /** The host's id. */
  readonly host: PeerId;
  /** Every open link, in the order they opened. */
  readonly links: () => readonly PeerLink[];
  readonly subscribe: (listener: (event: RoomEvent) => void) => () => void;
  /**
   * Host only: starts the run, so the room admits no one else. Guests still connecting are
   * dropped (`peer-left`) when the worker confirms with `started`.
   */
  readonly start: () => void;
  /** Leaves: closes the socket and every link, the run's too. */
  readonly close: () => void;
}

/** The socket to the signalling worker, as the room uses it. */
export interface SignallingSocket {
  readonly send: (text: string) => void;
  readonly close: () => void;
}

export interface SignallingSocketHandlers {
  readonly open: () => void;
  readonly message: (text: string) => void;
  /** Called once, when the socket closes or fails to open. */
  readonly close: () => void;
}

export interface SignallingOptions {
  /** The worker's base URL, such as `wss://signalling.example.com` or `ws://localhost:8787`. */
  readonly url: string;
  /** WebRTC settings (STUN servers). Ignored when `connectPeer` is given. */
  readonly rtc?: RtcOptions;
  /** Makes each peer link. Defaults to `rtcConnectPeer(rtc)`; tests pass a fake. */
  readonly connectPeer?: ConnectPeer;
  /** Opens the socket. Defaults to a browser `WebSocket`; tests pass a fake. */
  readonly openSocket?: (
    url: string,
    handlers: SignallingSocketHandlers
  ) => SignallingSocket;
}

/** Opens a new room as its host. Its join code arrives in the `welcome` event. */
export const hostRoom = (options: SignallingOptions): SignallingRoom =>
  createRoom(options, "host", undefined);

/** Joins the room with join code `code`, as typed (any case). */
export const joinRoom = (
  options: SignallingOptions,
  code: string
): SignallingRoom => createRoom(options, "guest", code);

const failureMessage = (reason: RoomFailure, url: string): string => {
  switch (reason) {
    case "unknown-code": {
      return "No room has that code. Check it, or ask the host for a new one.";
    }
    case "code-taken": {
      return "That join code is already in use. Try hosting again.";
    }
    case "full": {
      return "That room is full.";
    }
    case "started": {
      return "That run has already started.";
    }
    case "expired": {
      return "The room expired. Host a new one.";
    }
    case "host-left": {
      return "The host left.";
    }
    case "bad-message":
    case "not-allowed": {
      return `The signalling server refused a message (${reason}).`;
    }
    case "unreachable": {
      return `Couldn't reach the signalling server at ${url}.`;
    }
    case "lost": {
      return "Lost the connection to the signalling server.";
    }
    case "bad-code": {
      return "A join code is 6 letters and digits.";
    }
    case "peer-failed": {
      return "Couldn't connect to the host.";
    }
  }
};

const browserSocket = (
  url: string,
  handlers: SignallingSocketHandlers
): SignallingSocket => {
  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
  } catch {
    // A malformed URL throws at once; report it as the socket closing.
    queueMicrotask(handlers.close);
    // oxlint-disable-next-line eslint/no-empty-function -- a socket that never opened sends and closes nothing.
    return { send: () => {}, close: () => {} };
  }
  socket.addEventListener("open", handlers.open);
  socket.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (typeof event.data === "string") {
      handlers.message(event.data);
    }
  });
  // An error is always followed by close.
  socket.addEventListener("close", handlers.close, { once: true });
  return {
    send: (text) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(text);
      }
    },
    close: () => socket.close(1000, "done"),
  };
};

const createRoom = (
  options: SignallingOptions,
  role: "host" | "guest",
  typedCode: string | undefined
): SignallingRoom => {
  const base = options.url.replace(/\/+$/u, "");
  const connectPeer = options.connectPeer ?? rtcConnectPeer(options.rtc);
  const openSocket = options.openSocket ?? browserSocket;
  const listeners = new Set<(event: RoomEvent) => void>();
  // Peers being connected, and peers whose links are open, by id.
  const connecting = new Map<PeerId, PeerConnecting>();
  const links = new Map<PeerId, PeerLink>();
  let status: RoomStatus = "connecting";
  let code: string | undefined;
  let self: PeerId | undefined;
  let socket: SignallingSocket | undefined;

  const emit = (event: RoomEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  const send = (message: ClientMessage) =>
    socket?.send(JSON.stringify(message));

  const closeLinks = () => {
    for (const peer of connecting.values()) {
      peer.close();
    }
    for (const link of links.values()) {
      link.close();
    }
    connecting.clear();
    links.clear();
  };

  const fail = (
    reason: RoomFailure,
    message = failureMessage(reason, base)
  ) => {
    if (status === "failed" || status === "closed") {
      return;
    }
    status = "failed";
    socket?.close();
    closeLinks();
    emit({ type: "failed", reason, message });
  };

  /** A peer leaves before the start: its socket closed, its connection failed or its link closed. */
  const peerLeft = (peer: PeerId, reason?: string) => {
    const pending = connecting.get(peer);
    const link = links.get(peer);
    if (pending === undefined && link === undefined) {
      return;
    }
    connecting.delete(peer);
    links.delete(peer);
    pending?.close();
    link?.close();
    if (role === "guest") {
      fail("peer-failed", reason ?? failureMessage("host-left", base));
      return;
    }
    emit(
      reason === undefined
        ? { type: "peer-left", peer }
        : { type: "peer-left", peer, reason }
    );
  };

  const connect = (peer: PeerId) => {
    let connection: PeerConnecting;
    try {
      connection = connectPeer({
        peer,
        initiator: role === "host",
        sendSignal: (signal: Signal) =>
          send({ type: "signal", to: peer, signal }),
        onOpen: (link) => {
          if (connecting.get(peer) !== connection) {
            link.close();
            return;
          }
          connecting.delete(peer);
          links.set(peer, link);
          // Before the start, a link that closes is a peer that left. After, it's the run's business.
          const leftEarly = () => {
            if (status === "open") {
              peerLeft(peer);
            }
          };
          link.messages.onClose(leftEarly);
          link.lockstep.onClose(leftEarly);
          emit({ type: "peer-connected", peer, link });
        },
        onFail: (reason) => {
          if (connecting.get(peer) === connection) {
            peerLeft(peer, reason);
          }
        },
      });
    } catch (error) {
      // Such as `RTCPeerConnection` refusing a malformed STUN URL.
      const reason = `WebRTC setup with ${peer} failed: ${error instanceof Error ? error.message : String(error)}`;
      if (role === "guest") {
        fail("peer-failed", reason);
      } else {
        emit({ type: "peer-left", peer, reason });
      }
      return;
    }
    connecting.set(peer, connection);
  };

  const receive = (text: string) => {
    if (status !== "connecting" && status !== "open") {
      return;
    }
    const message = parseServerMessage(text);
    if (message === undefined) {
      return;
    }
    switch (message.type) {
      case "welcome": {
        if (status !== "connecting") {
          return;
        }
        status = "open";
        ({ code, self } = message);
        emit({ type: "welcome", code: message.code, self: message.self });
        if (role === "guest") {
          connect(message.host);
        }
        return;
      }
      case "peer-joined": {
        if (role === "host" && !connecting.has(message.peer)) {
          emit({ type: "peer-joined", peer: message.peer });
          connect(message.peer);
        }
        return;
      }
      case "peer-left": {
        peerLeft(message.peer);
        return;
      }
      case "signal": {
        connecting.get(message.from)?.receive(message.signal);
        return;
      }
      case "started": {
        if (role === "guest" && !links.has(HOST_ID)) {
          fail("started");
          return;
        }
        status = "started";
        socket?.close();
        // Whoever isn't linked yet can't play: no late join.
        for (const [peer, pending] of connecting) {
          pending.close();
          emit({
            type: "peer-left",
            peer,
            reason: "not connected at the start",
          });
        }
        connecting.clear();
        emit({ type: "started" });
        return;
      }
      case "error": {
        fail(message.reason);
      }
    }
  };

  const path =
    role === "host" ? "/host" : `/join/${normalizeJoinCode(typedCode ?? "")}`;
  if (role === "guest" && normalizeJoinCode(typedCode ?? "") === undefined) {
    // Report it after the caller has had the chance to subscribe.
    queueMicrotask(() => fail("bad-code"));
  } else {
    let opened = false;
    socket = openSocket(`${base}${path}`, {
      open: () => {
        opened = true;
      },
      message: receive,
      close: () => {
        if (status === "connecting" || status === "open") {
          fail(opened ? "lost" : "unreachable");
        }
      },
    });
  }

  return {
    role,
    get status() {
      return status;
    },
    get code() {
      return code;
    },
    get self() {
      return self;
    },
    host: HOST_ID,
    links: () => [...links.values()],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: () => {
      if (role === "host" && status === "open") {
        send({ type: "start" });
      }
    },
    close: () => {
      if (status === "closed") {
        return;
      }
      status = "closed";
      socket?.close();
      closeLinks();
    },
  };
};
