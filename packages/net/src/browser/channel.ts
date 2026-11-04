import type { PeerId, Transport } from "../transport";

/**
 * One direction-agnostic text pipe to one peer: what an `RTCDataChannel` is to this module. The
 * WebRTC peer link makes two per peer (`PeerLink`); tests pass fakes.
 */
export interface TextChannel {
  /** Sends one message. Never throws: a message on a channel that isn't open is lost. */
  readonly send: (text: string) => void;
  /** Calls `handler` with each message that arrives, until the returned function is called. */
  readonly listen: (handler: (text: string) => void) => () => void;
  /** Calls `handler` once when the channel closes, until the returned function is called. */
  readonly onClose: (handler: () => void) => () => void;
  readonly isOpen: () => boolean;
}

/**
 * Two channels to one peer, open: a WebRTC connection once it is set up. `lockstep` is
 * unreliable and unordered, for a lockstep session's `Transport` (`linksTransport`), which
 * resends what isn't acknowledged on every tick; `messages` is reliable and ordered, for what
 * the app says around a run (a lobby's hero picks and its start).
 */
export interface PeerLink {
  readonly peer: PeerId;
  readonly lockstep: TextChannel;
  readonly messages: TextChannel;
  /** Closes both channels and the connection. */
  readonly close: () => void;
}

/**
 * The WebRTC adapter of `@gamekit/net`'s `Transport` seam: one lockstep run's messages over the
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

/** An `RTCDataChannel` as a `TextChannel`. Binary messages are ignored: everything here is text. */
export const dataChannelText = (channel: RTCDataChannel): TextChannel => ({
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
    const onMessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data === "string") {
        handler(event.data);
      }
    };
    channel.addEventListener("message", onMessage);
    return () => channel.removeEventListener("message", onMessage);
  },
  onClose: (handler) => {
    const onClose = () => handler();
    channel.addEventListener("close", onClose, { once: true });
    return () => channel.removeEventListener("close", onClose);
  },
  isOpen: () => channel.readyState === "open",
});
