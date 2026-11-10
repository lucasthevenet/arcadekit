import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * The docs site on Cloudflare: the VitePress build (`dist/`) as the static assets of a Worker
 * with no script, so Cloudflare's asset layer answers every request itself.
 *
 * `alchemy deploy` builds the site and uploads it; see README.md for the credentials.
 * `alchemy dev` builds it and serves it from a local Worker, as Cloudflare would. To write docs,
 * use `pnpm dev` (`vitepress dev`) instead: it reloads a page as its README changes.
 *
 * `domain` is the site's own hostname, attached to the Worker as a Cloudflare custom domain (its
 * zone must be in the account). Only the prod stage has one; every other stage is served at its
 * `workers.dev` URL, so two stages never claim the same hostname.
 */
const website = (domain: string | undefined) =>
  Cloudflare.Website.StaticSite("Docs", {
    command: "pnpm run build",
    outdir: "dist",
    // The build reads markdown from all over the repository (.vitepress/pages.ts), which a hash
    // of this folder would miss, and it takes seconds. So it runs on every deploy.
    memo: false,
    assets: {
      // A page is one file, `net/worker.html`, served at `/net/worker`.
      htmlHandling: "drop-trailing-slash",
      notFoundHandling: "404-page",
    },
    ...(domain === undefined ? {} : { domain }),
  });

/** Where the docs are read: the prod stage's hostname. */
export const PROD_DOMAIN = "arcadekit.dev";

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
  "arcadekit-docs",
  {
    providers: Cloudflare.providers(),
    state,
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const site = yield* website(stage === "prod" ? PROD_DOMAIN : undefined);
    return { url: site.url };
  })
);
