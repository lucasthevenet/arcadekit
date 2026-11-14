/**
 * WebRTC transports: a lockstep run's messages over the `lockstep` channel of each peer link.
 *
 * It is the browser's adapter of `arcadekit/net`'s `Transport` seam, named for its mechanism and
 * the module whose type it makes, as `FetchHttpClient` is Effect's. A host passes a link per
 * guest; a guest, its one link to the host (the host star). Plain on purpose:
 * a lockstep session sends from inside its tick, and what arrives is queued for the
 * tick to read; the links' lifecycle is the signalling room's scope, and the listener's is the
 * session's.
 *
 * @since 0.7.0
 */
import { make as makeTransport } from "../transport";
import type * as Transport from "../transport";
import type * as PeerLink from "./peer-link";

/**
 * A transport over the `lockstep` channel of each link, by peer id.
 *
 * **When to use**
 *
 * At a run's start, for its lockstep session: `RtcTransport.fromLinks(room.self, room.links())`.
 *
 * **Details**
 *
 * A message to a peer with no open link is lost, as the `Transport` contract allows, and so is
 * one the browser refuses (a full send buffer). The links are read once, when it is made: a link
 * that opens later is not the run's.
 *
 * **Example** (A guest's transport, over its link to the host)
 *
 * ```ts
 * import { PeerLink, RtcTransport } from "arcadekit/net/browser";
 * import { Effect } from "effect";
 *
 * const sent: string[] = [];
 * const toHost: PeerLink.TextChannel = {
 *   send: (text) => {
 *     sent.push(text);
 *   },
 *   listen: () => () => {},
 *   onClose: () => () => {},
 *   isOpen: () => true,
 * };
 * const link = PeerLink.make({ peer: "host", lockstep: toHost, messages: toHost, closed: Effect.never });
 * const transport = RtcTransport.fromLinks("guest-1", [link]);
 * transport.send("host", "inputs");
 * transport.send("guest-2", "lost");
 * sent; // => ["inputs"]
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const fromLinks = (
  self: Transport.PeerId,
  links: Iterable<PeerLink.PeerLink>
): Transport.Transport => {
  const channels = new Map<Transport.PeerId, PeerLink.TextChannel>();
  for (const link of links) {
    channels.set(link.peer, link.lockstep);
  }
  return makeTransport({
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
  });
};
