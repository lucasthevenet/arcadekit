# The signalling worker

The players of a co-op run find each other through a signalling worker: it introduces their peers by a join code, so they can open [WebRTC data channels](webrtc.md) to each other, and it is out of the loop once they have. `arcadekit/net/worker` is that worker, for Cloudflare, and an app deploys it as a Worker of its own, beside its site.

## The Worker

An app's whole Worker, over `arcadekit/net/worker`'s one module, `SignallingWorker`. It names the Durable Object class, since Cloudflare binds a class by its exported name, and it says which of its bindings are the rooms and the site's files:

```ts
import { SignallingWorker } from "arcadekit/net/worker";

/** One join code's room. */
export class SignallingRoom extends SignallingWorker.room({ roomSize: 4 }) {}

export default SignallingWorker.make({ rooms: "ROOMS", assets: "ASSETS" });
```

The app declares the rest where it declares its Worker: a Durable Object namespace of that class bound as `ROOMS`, the static assets bound as `ASSETS`, and the routes `/host` and `/join/*` sent to the Worker ahead of the assets. The survivors demo does it with [Alchemy](https://alchemy.run) in [`alchemy.run.ts`](../../examples/survivor-demo/alchemy.run.ts), and its `alchemy dev` runs the worker locally beside the site.

`SignallingWorker.room` takes `roomSize`, the most players a room holds, and `SignallingWorker.make` the names of the two bindings. [Its reference page](../../packages/arcadekit/src/net/worker/README.md#its-module) has both, the protocol it speaks, and what it limits and what it doesn't before a game is public.

There's no TURN server yet, so two peers behind symmetric NATs can't connect; peers use free public STUN servers, which are the client's configuration ([`CoopRooms.layer`](coop.md)), not the worker's.
