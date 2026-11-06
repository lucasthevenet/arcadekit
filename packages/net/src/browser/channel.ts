import { Data } from "effect";
import type { Effect } from "effect";

import type { PeerId, Transport } from "../transport";

/**
 * One direction-agnostic text pipe to one peer: what an `RTCDataChannel` is to this module. The
 * WebRTC peer link makes two per peer (`PeerLink`); tests pass fakes.
 */
export interface TextChannel {
  /** Sends one message. Never throws: a message on a channel that isn't open is lost. */
  readonly send: (text: string) => void;
  /**
   * Calls `handler` with each message that arrives, until the returned function is called. The
   * first listener also gets, at once, what arrived before anything listened.
   */
  readonly listen: (handler: (text: string) => void) => () => void;
  /**
   * Calls `handler` once when the channel closes, until the returned function is called: at once,
   * if it has already closed.
   */
  readonly onClose: (handler: () => void) => () => void;
  readonly isOpen: () => boolean;
}

/**
 * Two channels to one peer, open: a WebRTC connection once it is set up. `lockstep` is
 * unreliable and unordered, for a lockstep session's `Transport` (`linksTransport`), which
 * resends what isn't acknowledged on every tick; `messages` is reliable and ordered, for what
 * the app says around a run (a lobby's hero picks and its start).
 *
 * The scope `PeerConnector.connect` ran in owns the link: closing that scope closes both
 * channels and the connection.
 */
export interface PeerLink {
  readonly peer: PeerId;
  readonly lockstep: TextChannel;
  readonly messages: TextChannel;
  /**
   * Succeeds once the link has closed: either channel closed, the connection failed, or the scope
   * that owns the link closed. Never fails.
   */
  readonly closed: Effect.Effect<void>;
}

// Named so the type files can be made one file at a time (isolatedDeclarations).
const PeerLinkErrorBase: ReturnType<typeof Data.TaggedError<"PeerLinkError">> =
  Data.TaggedError("PeerLinkError");

/**
 * A peer link that couldn't be made: setting it up threw (`setup`), ICE failed (`failed`), or its
 * channels didn't open in time (`timeout`). `message` says why, for a player.
 */
export class PeerLinkError extends PeerLinkErrorBase<{
  readonly peer: PeerId;
  readonly reason: "setup" | "failed" | "timeout";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The part of an `RTCDataChannel` this module uses, so tests can pass a fake. */
export interface DataChannelLike {
  readonly readyState: RTCDataChannelState;
  readonly send: (text: string) => void;
  readonly close: () => void;
  readonly addEventListener: (
    type: "open" | "close" | "message",
    listener: (event: { readonly data?: unknown }) => void,
    options?: { readonly once?: boolean }
  ) => void;
  readonly removeEventListener: (
    type: "open" | "close" | "message",
    listener: (event: { readonly data?: unknown }) => void
  ) => void;
}

/**
 * The WebRTC adapter of `@arcadekit/net`'s `Transport` seam: one lockstep run's messages over the
 * `lockstep` channel of each link, by peer id. A host passes a link per guest; a guest, its one
 * link to the host (the host star, ADR-0012). A message to a peer with no open link is lost,
 * as the `Transport` contract allows; so is one the browser refuses (a full send buffer).
 */
export const linksTransport = (
  self: PeerId,
  links: Iterable<PeerLink>
): Transport => {
  const channels = new Map<PeerId, TextChannel>();
  for (const link of links) {
    channels.set(link.peer, link.lockstep);
  }
  return {
    self,
    send: (to, message) => {
      channels.get(to)?.send(message);
    },
    listen: (handler) => {
      const stops = [...channels].map(([peer, channel]) =>
        channel.listen((text) => handler(peer, text))
      );
      return () => {
        for (const stop of stops) {
          stop();
        }
      };
    },
  };
};

/**
 * An `RTCDataChannel` as a `TextChannel`. Binary messages are ignored: everything here is text.
 * Make it when the channel is created: until something listens, it keeps what arrives, so a
 * message the other side sends as soon as its end opens isn't lost before this side's code
 * gets to listen.
 */
export const dataChannelText = (channel: DataChannelLike): TextChannel => {
  const handlers = new Set<(text: string) => void>();
  let early: string[] | null = [];
  channel.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      return;
    }
    if (early === null) {
      for (const handler of handlers) {
        handler(event.data);
      }
    } else {
      early.push(event.data);
    }
  });
  return {
    send: (text) => {
      if (channel.readyState !== "open") {
        return;
      }
      try {
        channel.send(text);
      } catch {
        // The channel closed, or its send buffer is full: the message is lost, which the
        // lockstep session tolerates and the lobby's reliable channel never hits in practice.
      }
    },
    listen: (handler) => {
      handlers.add(handler);
      if (early !== null) {
        const kept = early;
        early = null;
        for (const text of kept) {
          handler(text);
        }
      }
      return () => handlers.delete(handler);
    },
    onClose: (handler) => {
      // A channel that has closed fires no other close event, but one still queued may follow.
      let fired = false;
      const onClose = () => {
        if (!fired) {
          fired = true;
          handler();
        }
      };
      channel.addEventListener("close", onClose, { once: true });
      if (channel.readyState === "closed") {
        onClose();
      }
      return () => channel.removeEventListener("close", onClose);
    },
    isOpen: () => channel.readyState === "open",
  };
};
