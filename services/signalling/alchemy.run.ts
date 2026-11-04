import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

import type { SignallingRoom } from "./src/worker";

/**
 * The signalling worker's infrastructure (#25, ADR-0012): one Worker, and a Durable Object
 * namespace whose objects are the rooms, one per join code. `alchemy deploy` creates both; see
 * README.md for the credentials it needs. Nothing here runs in tests or the typecheck's eyes
 * beyond its types.
 */
export const Signalling = Cloudflare.Worker("Signalling", {
  main: "./src/worker.ts",
  env: {
    ROOMS: Cloudflare.DurableObject<SignallingRoom>("SignallingRoom"),
  },
});

export default Alchemy.Stack(
  "gamekit-signalling",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Signalling;
    return { url: worker.url };
  })
);
