import {
  DEFAULT_ICE_SERVERS,
  browserRoomLayer,
  hostRoom,
  joinRoom,
} from "arcadekit/net/browser";
import { Effect } from "effect";

import type { CoopRooms } from "./client";

// Where co-op finds the signalling worker and STUN.
//
// The signalling worker is the same Worker that serves the page (alchemy.run.ts routes `/host`
// and `/join/*` to it, under `alchemy dev` and deployed alike), so its URL is the page's own
// origin, over WebSocket.
//
// VITE_STUN_URLS, from Vite's env (`.env.local` or the shell): comma-separated STUN URLs.
// Defaults to a free public one; empty for none (local addresses only, as on one machine).

export const signallingUrl = (): string =>
  `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;

export const iceServers = (): readonly RTCIceServer[] =>
  import.meta.env.VITE_STUN_URLS === undefined
    ? DEFAULT_ICE_SERVERS
    : import.meta.env.VITE_STUN_URLS.split(",")
        .map((url) => url.trim())
        .filter((url) => url !== "")
        .map((url) => ({ urls: url }));

/**
 * The browser's rooms: the signalling worker on the page's origin, and WebRTC links with
 * `iceServers()`. It reads the page's location, so call it once the page runs, not at import.
 */
export const browserRooms = (): CoopRooms => {
  const options = { url: signallingUrl() };
  const services = browserRoomLayer({ iceServers: iceServers() });
  return {
    host: hostRoom(options).pipe(Effect.provide(services)),
    join: (code) => joinRoom(options, code).pipe(Effect.provide(services)),
  };
};
