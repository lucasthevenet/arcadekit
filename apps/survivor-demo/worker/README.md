# Signalling worker

Introduces the peers of a co-op run so they can open WebRTC data channels to each other ([#25](https://github.com/lucasthevenet/gamekit/issues/25), [ADR-0012](../../../docs/adr/0012-delay-based-lockstep-over-a-host-star.md)). It's the survivors demo's Worker: the same Cloudflare Worker that serves the demo's files answers `/host` and `/join/<code>`, with one Durable Object per join code, all declared with [Alchemy](https://alchemy.run) in the demo's `alchemy.run.ts`. It never carries game input: once the data channels are open, the peers close their sockets and the worker is out of the loop.

`alchemy dev` runs it locally beside the site, and `alchemy deploy` deploys both; see [the demo's README](../README.md).

## The protocol

JSON over one WebSocket per peer. `@gamekit/net/signalling` (`packages/net/src/signalling/protocol.ts`) has every message type, the parsers and the join-code helpers. It lives beside the browser's signalling client, which speaks it, and has no dependencies and no DOM, so this worker imports it as is.

1. The host opens `wss://<worker>/host`. The worker picks a join code and answers `welcome` with it; the host's peer id is `host`.
2. Each guest opens `wss://<worker>/join/<code>` and gets `welcome` with its own id (`guest-1`, `guest-2`, …, never reused). The host gets `peer-joined`.
3. The host sends `{ type: "signal", to, signal }` with an offer to each guest, and the guest answers the same way. ICE candidates follow in both directions (`candidate: ""` is the end of candidates). The worker relays each one as `{ type: "signal", from, signal }`. A guest may signal only the host, as in the star.
4. Once every data channel is open, the host sends `{ type: "start" }`. Everyone gets `started`, and the room admits no one else (no late join). The peers then close their sockets. If the host's closes first, the worker closes the guests' sockets normally (1000), with no error.

The worker answers with `{ type: "error", reason }` and closes the socket (code 4000, the reason as the close reason) when a 5th player tries to join (`full`), the code is unknown or its room has ended (`unknown-code`), a host's fresh code is already in use (`code-taken`: open `/host` again for another), the run has started (`started`), the room has lived 10 minutes (`expired`), the host left before the start (`host-left`), or a peer sends something that isn't the protocol (`bad-message`, `not-allowed`). If a guest leaves before the start, the host gets `peer-left`.

### Abuse

The worker trusts whoever holds a join code. A code is 6 letters from a 31-letter alphabet, a room lives at most 10 minutes and holds at most 4 players, and a message is at most 16 KB. That is all it limits today: there is no rate limit on `/host` or `/join`, no `Origin` check, no limit on how many messages a socket sends, and the host can't kick a guest. So a stranger who guesses or overhears a live code can take a seat, or fill the room, and each guessed `/join/<code>` wakes a Durable Object. That is acceptable while the demo is only shared among friends. Before it is public, it needs a per-IP rate limit (Cloudflare's rate-limiting binding) on `/host` and `/join`, an `Origin` allowlist, a cap on messages per socket that closes with `bad-message`, and a host `kick` message.

## The code

- `room.ts`: one room's rules (`createRoom`): who's in it, who may signal whom, the start, expiry. It deals in peer ids and returns what to send and whom to close, so it's tested without Cloudflare.
- `sockets.ts`: the adapter from a room to sockets (`createSocketRoom`), tested with fake sockets.
- `worker.ts`: the Worker's routes and the `SignallingRoom` Durable Object, which only wires Cloudflare's WebSockets and its expiry alarm to `createSocketRoom`. Any path but the signalling routes goes to the site's files (`ASSETS`). Rooms live in memory: they last minutes, and their open WebSockets keep the object alive.

`pnpm test` (from the repo root) runs the room's, the sockets' and the protocol's tests. `pnpm typecheck` checks this folder and `alchemy.run.ts` against Cloudflare's Workers types and Alchemy's API (`tsconfig.worker.json`), and the protocol with no Workers or DOM types. Neither needs credentials. The co-op end-to-end test (`pnpm test:e2e`) plays through this worker under `alchemy dev`.

There's no TURN server yet, so two peers behind symmetric NATs can't connect; peers use free public STUN servers, which are the client's configuration, not the worker's.
