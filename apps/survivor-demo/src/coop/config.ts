import { DEFAULT_ICE_SERVERS } from "@gamekit/net/browser";

// Where co-op finds the signalling worker and STUN, from Vite's env (`.env.local` or the shell):
//
// - VITE_SIGNALLING_URL: the worker's base URL. Defaults to the local server
//   (`pnpm dev:signalling`) on port 8787 of the host serving the page, so a LAN works too.
// - VITE_STUN_URLS: comma-separated STUN URLs. Defaults to a free public one; empty for none
//   (local addresses only, as on one machine).

export const signallingUrl = (): string =>
  import.meta.env.VITE_SIGNALLING_URL ??
  `ws://${location.hostname || "localhost"}:8787`;

export const iceServers = (): readonly RTCIceServer[] =>
  import.meta.env.VITE_STUN_URLS === undefined
    ? DEFAULT_ICE_SERVERS
    : import.meta.env.VITE_STUN_URLS.split(",")
        .map((url) => url.trim())
        .filter((url) => url !== "")
        .map((url) => ({ urls: url }));
