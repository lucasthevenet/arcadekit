---
"arcadekit": minor
---

New entry `arcadekit/net/worker`: the signalling worker, for Cloudflare. It was the survivors demo's own code, which every game with co-op had to copy. An app's Worker is now a few lines:

```ts
import { signallingRoom, signallingWorker } from "arcadekit/net/worker";

export class SignallingRoom extends signallingRoom({ roomSize: 4 }) {}

export default signallingWorker({ rooms: "ROOMS", assets: "ASSETS" });
```

- `signallingRoom(options?)` returns the Durable Object class of one join code's room, for the app to extend and export under the name its binding declares. `signallingWorker({ rooms, assets })` returns the Worker's `fetch` handler, given the names of the app's two bindings. The app still declares its Worker, bindings and routes itself (the demo's `alchemy.run.ts`).
- The room size is a setting of the worker: `roomSize`, a whole number from 2 to `MAX_ROOM_SIZE` (16), and `DEFAULT_ROOM_SIZE` (4) if left out. `signallingRoom` throws a `RangeError` for any other size when the Worker's module loads; it never changes it to another one. A lockstep run's own limit on the wire is separate and unchanged.
- The worker behaves as the demo's did (ADR-0012). Its Effect service key is `arcadekit/net/worker/RoomConnections`.
- `@cloudflare/workers-types` (^5) is a new optional peer, for this entry's types. The entry imports `cloudflare:workers`, so it runs only on Cloudflare; typecheck a Worker that uses it with Workers types, no DOM `lib`, and `skipLibCheck` (Effect's own type files name DOM types).
- It adds no arrow between entries: the worker is in the `net` group and imports only `net/signalling`'s protocol.

**Breaking:**

- `arcadekit/net/signalling` exports `DEFAULT_ROOM_SIZE` (4) and `MAX_ROOM_SIZE` (16) in place of `MAX_PLAYERS` (4). Use `DEFAULT_ROOM_SIZE` where you used `MAX_PLAYERS`, unless your worker sets another room size.
- `parseServerMessage` accepts a `welcome` that lists up to `MAX_ROOM_SIZE - 1` peers (it was 3), so a client reads the welcome of a larger room.

No other entry changes.
