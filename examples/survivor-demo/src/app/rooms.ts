/**
 * Where co-op's rooms are: the signalling worker, and the STUN servers the peer links go through.
 * `resources` hands both to the kit's `CoopRooms.layer`, which calls them when it is built, so
 * the page's location is read then, not at import.
 *
 * The signalling worker is the same Worker that serves the page (`alchemy.run.ts` routes `/host`
 * and `/join/*` to it, under `alchemy dev` and deployed alike), so its URL is the page's own
 * origin, over WebSocket.
 *
 * Plain on purpose: `CoopRooms.layer` takes them in a plain function (the kit's contract), and
 * reading the page's location and Vite's env can't fail.
 */
import { RtcPeerConnector } from "arcadekit/net/browser";

/** The signalling worker's URL: the page's own host, over `wss:` from an `https:` page and `ws:` otherwise. */
export const url = (): string =>
  `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;

/**
 * The STUN servers, from `VITE_STUN_URLS` in Vite's env (`.env.local` or the shell): STUN URLs,
 * comma-separated, or empty for none, so the peer links try local addresses only, as on one
 * machine. Unset, they are the kit's default (`RtcPeerConnector.defaultIceServers`).
 */
export const iceServers = (): readonly RTCIceServer[] =>
  import.meta.env.VITE_STUN_URLS === undefined
    ? RtcPeerConnector.defaultIceServers
    : import.meta.env.VITE_STUN_URLS.split(",")
        .map((stun) => stun.trim())
        .filter((stun) => stun !== "")
        .map((stun) => ({ urls: stun }));
