# Signalling worker

Introduces the peers of a lockstep run so they can open WebRTC data channels to each other ([#25](https://github.com/lucasthevenet/gamekit/issues/25), [ADR-0012](../../docs/adr/0012-delay-based-lockstep-over-a-host-star.md)). It's a Cloudflare Worker with one Durable Object per join code, defined with [Alchemy](https://alchemy.run) in `alchemy.run.ts`. It never carries game input: once the data channels are open, the peers close their sockets and the worker is out of the loop.

**Not deployed yet.** No URL exists, and nothing in the kit or the demos calls it yet. The WebRTC transport in `@gamekit/net/browser` and the lobby UI will.

## The protocol

JSON over one WebSocket per peer. `src/protocol.ts` (`@gamekit/signalling/protocol`) has every message type, the parsers and the join-code helpers. It has no dependencies and no DOM, so the browser transport imports it as is.

1. The host opens `wss://<worker>/host`. The worker picks a join code and answers `welcome` with it; the host's peer id is `host`.
2. Each guest opens `wss://<worker>/join/<code>` and gets `welcome` with its own id (`guest-1`, `guest-2`, …, never reused). The host gets `peer-joined`.
3. The host sends `{ type: "signal", to, signal }` with an offer to each guest, and the guest answers the same way. ICE candidates follow in both directions (`candidate: ""` is the end of candidates). The worker relays each one as `{ type: "signal", from, signal }`. A guest may signal only the host, as in the star.
4. Once every data channel is open, the host sends `{ type: "start" }`. Everyone gets `started`, and the room admits no one else (no late join). The peers then close their sockets. If the host's closes first, the worker closes the guests' sockets normally (1000), with no error.

The worker answers with `{ type: "error", reason }` and closes the socket (code 4000, the reason as the close reason) when a 5th player tries to join (`full`), the code is unknown or its room has ended (`unknown-code`), a host's fresh code is already in use (`code-taken`: open `/host` again for another), the run has started (`started`), the room has lived 10 minutes (`expired`), the host left before the start (`host-left`), or a peer sends something that isn't the protocol (`bad-message`, `not-allowed`). If a guest leaves before the start, the host gets `peer-left`.

### Abuse

The worker trusts whoever holds a join code. A code is 6 letters from a 31-letter alphabet, a room lives at most 10 minutes and holds at most 4 players, and a message is at most 16 KB. That is all it limits today: there is no rate limit on `/host` or `/join`, no `Origin` check, no limit on how many messages a socket sends, and the host can't kick a guest. So a stranger who guesses or overhears a live code can take a seat, or fill the room, and each guessed `/join/<code>` wakes a Durable Object. That is acceptable while the worker is undeployed or only shared among friends. Before it is public, it needs a per-IP rate limit (Cloudflare's rate-limiting binding) on `/host` and `/join`, an `Origin` allowlist, a cap on messages per socket that closes with `bad-message`, and a host `kick` message.

## The code

- `src/protocol.ts`: the protocol's message types: the interface between the worker and the browser.
- `src/room.ts`: one room's rules (`createRoom`): who's in it, who may signal whom, the start, expiry. It deals in peer ids and returns what to send and whom to close, so it's tested without Cloudflare.
- `src/sockets.ts`: the adapter from a room to sockets (`createSocketRoom`), tested with fake sockets.
- `src/worker.ts`: the Worker's routes and the `SignallingRoom` Durable Object, which only wires Cloudflare's WebSockets and its expiry alarm to `createSocketRoom`. Rooms live in memory: they last minutes, and their open WebSockets keep the object alive.
- `alchemy.run.ts`: the infrastructure: the Worker and its `ROOMS` Durable Object namespace binding.

`pnpm test` (from the repo root) runs the room's and the protocol's tests. `pnpm typecheck` checks the worker against Cloudflare's Workers types and `alchemy.run.ts` against Alchemy's API, and checks the protocol, room and socket modules again with no Workers or DOM types. Neither needs credentials.

## Deploying

Alchemy 2 (beta) deploys it. You need a Cloudflare account; Alchemy creates the Durable Object class backed by SQLite, which Workers' free plan allows.

Set these in the environment (or run `pnpm exec alchemy profile create` once and log in interactively instead):

| Variable | What it is |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | An API token that can edit Workers scripts (and read the account), from the Cloudflare dashboard |
| `CLOUDFLARE_ACCOUNT_ID` | The account to deploy into |

Then, from this folder:

```bash
pnpm run plan --stage prod     # what would change
pnpm run deploy --stage prod   # create or update the Worker and the Durable Object namespace
pnpm run destroy --stage prod  # remove them
```

(`pnpm run deploy`, not `pnpm deploy`, which is a pnpm command of its own.)

The stage defaults to `live_<your user name>`, so a deploy without `--stage` makes a personal copy. Alchemy keeps its state in a small state-store Worker in the same Cloudflare account (`Cloudflare.state()`), which it creates on the first deploy, so a deploy from CI sees the same state as one from your machine. The deploy prints the Worker's `url`; the browser transport will connect to it with `wss://`.

`pnpm run dev` runs it locally under `alchemy dev`, which needs `workerd`. pnpm skips `workerd`'s install script by default; allow it with `pnpm approve-builds` first.

There's no TURN server yet, so two peers behind symmetric NATs can't connect; peers use free public STUN servers, which are the transport's configuration, not the worker's.
