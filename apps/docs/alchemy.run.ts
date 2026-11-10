import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "arcadekit-docs",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const site = yield* Cloudflare.Website.StaticSite("Docs", {
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
      ...(stage === "prod" ? { domain: "arcadekit.dev"} : {}),
    })

    return { url: site.url };
  })
);
