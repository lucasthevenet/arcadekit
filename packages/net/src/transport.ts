/** A peer's address on a transport: unique within one lockstep run. */
export type PeerId = string;

/**
 * Carries text messages between the peers of one lockstep run. It is the seam between the
 * lockstep session and the network. It has two adapters: the in-memory network
 * (`createMemoryNetwork`) for tests, and WebRTC data channels (`linksTransport` in
 * `@gamekit/net/browser`) for the browser.
 *
 * A transport may lose, delay, duplicate and reorder messages: the session resends what isn't
 * acknowledged and ignores what it already has, so an unreliable, unordered channel is enough.
 * It need not reach every peer, only the ones the session sends to (in a host star, a peer
 * talks to the host only).
 */
export interface Transport {
  /** This peer's id. */
  readonly self: PeerId;
  /** Sends one message to `to`. Never throws: a message to an unknown or gone peer is lost. */
  readonly send: (to: PeerId, message: string) => void;
  /**
   * Calls `handler` with each message that arrives, until the returned function is called. The
   * handler must not send synchronously; the session only queues what arrives.
   */
  readonly listen: (
    handler: (from: PeerId, message: string) => void
  ) => () => void;
}
