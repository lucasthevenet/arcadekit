import type * as PeerLink from "../peer-link";
import type * as RtcPeerConnector from "../rtc-peer-connector";

/**
 * An `RTCDataChannel` as a peer link's `TextChannel`. Binary messages are ignored: everything a
 * link carries is text. Make it when the channel is created: until something listens, it keeps
 * what arrives, so a message the other side sends as soon as its end opens isn't lost before this
 * side's code gets to listen.
 *
 * Plain on purpose (ADR-0024): its listener writes what arrives while the browser dispatches the
 * message, which a lockstep session's tick reads as state and a lobby offers to its queue. The
 * channel's lifecycle is the connector's scope, which closes it.
 */
export const dataChannelText = (
  channel: RtcPeerConnector.DataChannelLike
): PeerLink.TextChannel => {
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
