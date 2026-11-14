# arcadekit/net/worker

The signalling worker, for Cloudflare. It introduces the peers of a co-op run so they can open WebRTC data channels to each other ([#25](https://github.com/lucasthevenet/arcadekit/issues/25)): it answers `/host` and `/join/<code>`, with one Durable Object per join code, and sends every other path to the site's files. It never carries game input: once the data channels are open, the peers close their sockets and the worker is out of the loop. [`arcadekit/net/browser`](../README.md)'s `SignallingRoom.host` and `SignallingRoom.join` are its client.

An entry of the [`arcadekit`](../../../README.md) package. It runs only on Cloudflare Workers: it imports `cloudflare:workers`, and it has no DOM.

## Install

```bash
pnpm add arcadekit effect
pnpm add -D @cloudflare/workers-types
```

Peer dependencies: `effect` (~4.1), and `@cloudflare/workers-types` (^5) for the types of Cloudflare's runtime. Typecheck your Worker with `"types": ["@cloudflare/workers-types"]` and no DOM `lib`. That typecheck needs `skipLibCheck`, since Effect's own type files name DOM types.

## Its module

[`SignallingWorker`](signalling-worker.ts) is the entry's one module:

- `SignallingWorker.room(options?)` returns the Durable Object class of one room, for the app to extend. `roomSize` is the most players a room holds, host included: a whole number from 2 to `Room.maxSize` (16), and `Room.defaultSize` (4) if left out; both constants are in `arcadekit/net/signalling`. Any other size throws a `RangeError` when the Worker's module loads, so a wrong size fails the deploy and is never changed to another one. A lockstep run has its own limit on the wire, which is not this setting.
- `SignallingWorker.make({ rooms, assets })` returns the Worker's default export, a `fetch` handler. `rooms` and `assets` are the names of the two bindings in the Worker's `env`.

## Example

An app's whole Worker. It names the Durable Object class, since Cloudflare binds a class by its exported name, and it says which of its bindings are the rooms and the site's files:

```ts
import { SignallingWorker } from "arcadekit/net/worker";

/** One join code's room. */
export class SignallingRoom extends SignallingWorker.room({ roomSize: 4 }) {}

export default SignallingWorker.make({ rooms: "ROOMS", assets: "ASSETS" });
```

[The signalling worker](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/signalling-worker.md) says what an app declares beside it, and how the survivors demo deploys it.

## The protocol

JSON over one WebSocket per peer. `arcadekit/net/signalling` (`../signalling/`) has every message as an Effect Schema, whose types are the messages' types (`ClientMessage`, `ServerMessage`, `Signal`), with their parsers (`ClientMessage.fromJson`, `ServerMessage.fromJson`), the join code's (`JoinCode`), a peer's id (`PeerId`) and a room's limits (`Room`). It lives beside the browser's signalling client, which speaks it, and needs nothing but `effect` and no DOM, so this worker imports it as is. A message that doesn't decode is `bad-message`: a client message is at most 16 KB (`ClientMessage.maxLength`), a peer id at most 32 characters (`PeerId.maxLength`), an `sdpMid` or ICE username fragment at most 256 (`Signal.maxTokenLength`), and `sdpMLineIndex` is 0 to 65535.

1. The host opens `wss://<worker>/host`. The worker picks a join code and answers `welcome` with it; the host's peer id is `host`.
2. Each guest opens `wss://<worker>/join/<code>` and gets `welcome` with its own id (`guest-1`, `guest-2`, …, never reused). The host gets `peer-joined`.
3. The host sends `{ type: "signal", to, signal }` with an offer to each guest, and the guest answers the same way. ICE candidates follow in both directions (`candidate: ""` is the end of candidates). The worker relays each one as `{ type: "signal", from, signal }`. A guest may signal only the host, as in the star.
4. Once every data channel is open, the host sends `{ type: "start" }`. Everyone gets `started`, and the room admits no one else (no late join). The peers then close their sockets. If the host's closes first, the worker closes the guests' sockets normally (1000), with no error.

If the worker can't set a new room's expiry alarm, it answers the host's `/host` with 503 and keeps no room for that code, so the host can open `/host` again.

The worker answers with `{ type: "error", reason }` and closes the socket (code 4000, the reason as the close reason) when a player joins a room that already holds its room size (`full`), the code is unknown or its room has ended (`unknown-code`), a host's fresh code is already in use (`code-taken`: open `/host` again for another), the run has started (`started`), the room has lived 10 minutes (`expired`), the host left before the start (`host-left`), or a peer sends something that isn't the protocol (`bad-message`, `not-allowed`). If a guest leaves before the start, the host gets `peer-left`.

### Abuse

The worker trusts whoever holds a join code. A code is 6 letters from a 31-letter alphabet, a room lives at most 10 minutes and holds at most its room size (4 unless the app sets another), and a message is at most 16 KB. That is all it limits today: there is no rate limit on `/host` or `/join`, no `Origin` check, no limit on how many messages a socket sends, and the host can't kick a guest. So a stranger who guesses or overhears a live code can take a seat, or fill the room, and each guessed `/join/<code>` wakes a Durable Object. That is acceptable while a game is only shared among friends. Before it is public, it needs a per-IP rate limit (Cloudflare's rate-limiting binding) on `/host` and `/join`, an `Origin` allowlist, a cap on messages per socket that closes with `bad-message`, and a host `kick` message.

## The code

The entry's one module is `signalling-worker.ts`; the rest is in `internal/`, which no game imports. What is plain is plain on purpose.

- `internal/room.ts`: one room's rules (`makeRoom`): who's in it, who may signal whom, the start, expiry. It deals in peer ids and returns what to send and whom to close, so it's tested without Cloudflare. `checkRoomSize` refuses a room size no room can have. Plain: a reducer, whose refusal is a value.
- `internal/sockets.ts`: the adapter from a room to sockets (`makeSocketRoom`): which socket is which peer, and carrying out the room's sends and closes. Plain: each output is one synchronous call on a socket, and a send or a close that throws is a socket already closing, whose close event tells the room. Tested with fake sockets.
- `internal/connections.ts`: the Durable Object's work as Effects. Each socket's connection is one fiber: the room admits it, a host's expiry alarm is set (and if that fails, the room forgets the host and the request gets 503), then the room gets its messages until the socket closes. `roomLayer` is what the object's runtime holds, on Effect's synchronous scheduler: Cloudflare can drop the timers a request leaves behind, and a connection outlives the request that opened it. Tested with fake sockets, a fake storage and a test clock.
- `internal/routes.ts`: the Worker's routes as an Effect (`handleRequest`). Any path but the signalling routes goes to the site's files; a binding that fails is logged and answered 503. Tested with fake bindings.
- `signalling-worker.ts`: Cloudflare's entry points only, and the entry's whole interface, `SignallingWorker`. The Worker's `fetch` runs `handleRequest` with `Effect.runPromise`, since nothing outlives a request. The Durable Object builds one `ManagedRuntime` from `roomLayer` and runs its `fetch` and `alarm` on it, since its connections outlive the request that opened them. It is the one file of the kit that runs an Effect itself, since Cloudflare owns its entry points. Rooms live in memory: they last minutes, and their open WebSockets keep the object alive. Its test (`signalling-worker.test.ts`) runs it over fakes of Cloudflare's objects, to check that the room size reaches the room; the co-op end-to-end test runs it on Cloudflare's runtime.

`pnpm test` (from the repo root) runs the room's, the sockets', the connections', the routes' and the protocol's tests. `pnpm typecheck` checks this folder against Cloudflare's Workers types, with no DOM types (`packages/arcadekit/tsconfig.worker.json`); no other entry is checked with them. Neither needs credentials. The co-op end-to-end test (`pnpm test:e2e`) plays through this worker under the survivors demo's `alchemy dev`.
