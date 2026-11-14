import { ServerMessage } from "../../signalling/index";
import type { ClientMessage, Signal } from "../../signalling/index";
import type { PeerId } from "../../transport";
import type * as PeerLink from "../peer-link";
import { failureMessage } from "./room-failure";
import type { RoomFailure } from "./room-failure";

// The signalling client's rules as plain inputs and outputs, so they are tested without sockets,
// WebRTC or fibers. Plain on purpose (ADR-0024): a reducer, whose refusal is a value. The room's
// Effect shell (signalling-room.ts) turns what happens into inputs, one at a time, and carries
// out the outputs in order.

/**
 * What a room reports after its welcome, in order. A host hears `peer-joined` when a guest's
 * socket joins, then `peer-connected` once its link is open, or `peer-left` if it leaves or
 * can't connect before the start. A guest hears `peer-connected` once, for the host. A failure
 * is the room's RoomError, not an event.
 */
export type Event =
  | { readonly type: "peer-joined"; readonly peer: PeerId }
  | {
      readonly type: "peer-connected";
      readonly peer: PeerId;
      readonly link: PeerLink.PeerLink;
    }
  | {
      readonly type: "peer-left";
      readonly peer: PeerId;
      /** Why, when its connection failed rather than it leaving. */
      readonly reason?: string;
    }
  | { readonly type: "started" };

/** What happens to a room. */
export type RoomInput =
  /** A text frame from the worker, as it came: the room reads it. */
  | { readonly kind: "server"; readonly text: string }
  /** The socket closed or failed. `opened` says whether it had opened; `cause` is its error. */
  | {
      readonly kind: "socket-closed";
      readonly opened: boolean;
      readonly cause?: unknown;
    }
  /** The welcome timer, started when the socket opened, ran out. */
  | { readonly kind: "welcome-timeout" }
  | {
      readonly kind: "linked";
      readonly peer: PeerId;
      readonly link: PeerLink.PeerLink;
    }
  | {
      readonly kind: "link-failed";
      readonly peer: PeerId;
      readonly message: string;
    }
  | { readonly kind: "link-closed"; readonly peer: PeerId }
  /** The host asked to start. */
  | { readonly kind: "start" };

/** What the room asks its shell to do, in order. */
export type RoomOutput =
  | { readonly kind: "send"; readonly message: ClientMessage.ClientMessage }
  /** Start connecting to `peer`. Its signals follow as `signal` outputs. */
  | {
      readonly kind: "connect";
      readonly peer: PeerId;
      readonly initiator: boolean;
    }
  | {
      readonly kind: "signal";
      readonly peer: PeerId;
      readonly signal: Signal.Signal;
    }
  /** Close `peer`'s connection, or its link. The room has already forgotten it. */
  | { readonly kind: "drop"; readonly peer: PeerId }
  | { readonly kind: "welcomed"; readonly code: string; readonly self: PeerId }
  | { readonly kind: "event"; readonly event: Event }
  /** The run started: close the socket. The links carry the run, and the room hears nothing more. */
  | { readonly kind: "close-socket" }
  /** Close everything, and fail with a `RoomError` of this reason and message. Inputs after it do nothing. */
  | {
      readonly kind: "fail";
      readonly reason: RoomFailure;
      readonly message: string;
      readonly cause?: unknown;
    };

export interface RoomState {
  readonly handle: (input: RoomInput) => readonly RoomOutput[];
  /** The open links, in the order they opened. */
  readonly links: () => readonly PeerLink.PeerLink[];
}

/**
 * - `connecting`: waiting for the worker's welcome.
 * - `open`: in the lobby; guests come and go.
 * - `started`: the host started; the links are the run's.
 * - `failed`: see the `fail` output.
 */
type Phase = "connecting" | "open" | "started" | "failed";

/** One peer's side of a room: a host links to every guest, a guest only to the host. `url` is the worker's base URL. */
export const makeRoomState = (
  role: "host" | "guest",
  url: string
): RoomState => {
  let phase: Phase = "connecting";
  let host: PeerId | undefined;
  // Peers being connected, and peers whose links are open, by id.
  const connecting = new Set<PeerId>();
  const links = new Map<PeerId, PeerLink.PeerLink>();

  const fail = (
    reason: RoomFailure,
    details?: { readonly message?: string; readonly cause?: unknown }
  ): RoomOutput[] => {
    phase = "failed";
    connecting.clear();
    links.clear();
    const message = details?.message ?? failureMessage(reason, url);
    return [
      details?.cause === undefined
        ? { kind: "fail", reason, message }
        : { kind: "fail", reason, message, cause: details.cause },
    ];
  };

  /** A peer leaves before the start: its socket closed, its connection failed or its link closed. */
  const peerLeft = (peer: PeerId, reason?: string): RoomOutput[] => {
    if (!connecting.delete(peer) && !links.delete(peer)) {
      return [];
    }
    if (role === "guest") {
      return fail("peer-failed", {
        message: reason ?? failureMessage("host-left", url),
      });
    }
    return [
      { kind: "drop", peer },
      {
        kind: "event",
        event:
          reason === undefined
            ? { type: "peer-left", peer }
            : { type: "peer-left", peer, reason },
      },
    ];
  };

  const started = (): RoomOutput[] => {
    if (role === "guest" && (host === undefined || !links.has(host))) {
      return fail("started");
    }
    phase = "started";
    // Whoever isn't linked yet can't play: no late join.
    const outputs = [...connecting].flatMap((peer): RoomOutput[] => [
      { kind: "drop", peer },
      {
        kind: "event",
        event: {
          type: "peer-left",
          peer,
          reason: "not connected at the start",
        },
      },
    ]);
    connecting.clear();
    outputs.push(
      { kind: "event", event: { type: "started" } },
      { kind: "close-socket" }
    );
    return outputs;
  };

  const server = (text: string): RoomOutput[] => {
    if (phase !== "connecting" && phase !== "open") {
      return [];
    }
    const message = ServerMessage.fromJson(text);
    if (message === undefined) {
      return fail("bad-server-message");
    }
    if (phase === "connecting") {
      // The worker's first message is its welcome, or why it turned this peer away.
      switch (message.type) {
        case "welcome": {
          phase = "open";
          const outputs: RoomOutput[] = [
            { kind: "welcomed", code: message.code, self: message.self },
          ];
          if (role === "guest") {
            ({ host } = message);
            connecting.add(message.host);
            outputs.push({
              kind: "connect",
              peer: message.host,
              initiator: false,
            });
          }
          return outputs;
        }
        case "error": {
          return fail(message.reason);
        }
        default: {
          return fail("bad-server-message");
        }
      }
    }
    switch (message.type) {
      case "welcome": {
        return [];
      }
      case "peer-joined": {
        const { peer } = message;
        if (role !== "host" || connecting.has(peer) || links.has(peer)) {
          return [];
        }
        connecting.add(peer);
        return [
          { kind: "event", event: { type: "peer-joined", peer } },
          { kind: "connect", peer, initiator: true },
        ];
      }
      case "peer-left": {
        return peerLeft(message.peer);
      }
      case "signal": {
        return connecting.has(message.from)
          ? [{ kind: "signal", peer: message.from, signal: message.signal }]
          : [];
      }
      case "started": {
        return started();
      }
      case "error": {
        return fail(message.reason);
      }
    }
  };

  const handle = (input: RoomInput): readonly RoomOutput[] => {
    switch (input.kind) {
      case "server": {
        return server(input.text);
      }
      case "socket-closed": {
        if (phase === "connecting") {
          return fail(input.opened ? "lost" : "unreachable", {
            cause: input.cause,
          });
        }
        return phase === "open" ? fail("lost", { cause: input.cause }) : [];
      }
      case "welcome-timeout": {
        return phase === "connecting" ? fail("no-welcome") : [];
      }
      case "linked": {
        if (phase !== "open" || !connecting.delete(input.peer)) {
          return [];
        }
        links.set(input.peer, input.link);
        return [
          {
            kind: "event",
            event: {
              type: "peer-connected",
              peer: input.peer,
              link: input.link,
            },
          },
        ];
      }
      // After the start, a link that fails or closes is the run's business.
      case "link-failed": {
        return phase === "open" && connecting.has(input.peer)
          ? peerLeft(input.peer, input.message)
          : [];
      }
      case "link-closed": {
        return phase === "open" && links.has(input.peer)
          ? peerLeft(input.peer)
          : [];
      }
      case "start": {
        return role === "host" && phase === "open"
          ? [{ kind: "send", message: { type: "start" } }]
          : [];
      }
    }
  };

  return { handle, links: () => [...links.values()] };
};
