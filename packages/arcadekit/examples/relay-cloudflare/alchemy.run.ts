/**
 * A relay on Cloudflare, deployed with Alchemy (https://alchemy.run):
 * a Worker, and a Durable Object per room.
 *
 *   cd packages/arcadekit/examples/relay-cloudflare
 *   pnpm alchemy dev       # on this machine, in workerd
 *   pnpm alchemy deploy    # to a Cloudflare account
 *
 * It prints the Worker's address. A peer then connects with
 *
 *   Transport.layerWebSocket(
 *     Relay.address(`${url.replace(/^http/, "ws")}/rooms`, { room, peer })
 *   )
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Effect } from "effect";

import Relay from "./src/worker.ts";

export default Alchemy.Stack(
  "arcadekit-relay",
  {
    providers: Cloudflare.providers(),
    // Kept in `.alchemy/` beside this file, which is all `alchemy dev`
    // needs, and no account. A stack that several people or a CI deploy
    // keeps its state in the account instead: `Cloudflare.state()`.
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const relay = yield* Relay;
    return { url: relay.url };
  })
);
