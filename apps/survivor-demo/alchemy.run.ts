import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { SignallingRoom } from "./worker/worker";

/**
 * The survivors demo on Cloudflare (#25): one Worker that serves the Vite build as
 * static assets and answers the signalling routes, with a Durable Object namespace whose objects
 * are the co-op rooms, one per join code. The site and the signalling worker share one origin,
 * so the game opens its signalling sockets on the page's own host, with nothing to configure.
 *
 * `alchemy dev` runs it all locally: Vite's dev server with the Worker and its Durable Objects in
 * workerd. `alchemy deploy` builds the site and deploys both; see README.md for the credentials.
 */
export const Website = Cloudflare.Website.Vite("Website", {
  main: "./worker/worker.ts",
  env: {
    ROOMS: Cloudflare.DurableObject<SignallingRoom>("SignallingRoom"),
  },
  // Only the signalling routes reach the Worker first; every other path is the site's files.
  assets: { runWorkerFirst: ["/host", "/join/*"] },
});

/**
 * Where Alchemy keeps what it deployed: a state-store Worker in the Cloudflare account when
 * deploying, so every machine and CI see the same state, and files in `.alchemy/` under
 * `alchemy dev`, which runs locally and so needs no Cloudflare account.
 */
const state = Layer.unwrap(
  Effect.gen(function* () {
    const { dev } = yield* AlchemyContext;
    return dev ? Alchemy.localState() : Cloudflare.state();
  })
);

export default Alchemy.Stack(
  "arcadekit-survivor-demo",
  {
    providers: Cloudflare.providers(),
    state,
  },
  Effect.gen(function* () {
    const website = yield* Website;
    return { url: website.url };
  })
);
