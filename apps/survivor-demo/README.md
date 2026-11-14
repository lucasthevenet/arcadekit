# Survivors demo

The survivors-like demo game, and its Cloudflare deployment: one Worker that serves the site and is co-op's signalling worker, which is the kit's ([`arcadekit/net/worker`](../../packages/arcadekit/src/net/worker/README.md)), declared with [Alchemy](https://alchemy.run) in `alchemy.run.ts`. The game itself is described in the [root README](../../README.md#the-survivors-demo).

Co-op runs on the kit's Co-op client ([`arcadekit/net/browser`](../../packages/arcadekit/src/net/README.md#co-op)), which the genre's `SurvivorsCoop` declares from its engine. The app keeps the screens and the Foldkit glue: `src/app/main.ts` provides the client with `SurvivorsCoop.layer` over the app's rooms, which `src/app/rooms.ts` finds from the signalling worker's URL (the page's own origin) and the STUN servers, a Subscription hears it through `SurvivorsCoop.match`, and in development `src/app/coop-debug.ts` puts the client's run on a global for the end-to-end test.

## How the app is put together

`src/app/` is a Foldkit app over the genre in `src/survivors/`, shaped as the push-puzzle demo's app is:

- Foldkit's contract, under Foldkit's names: the Model (`model.ts`), the Messages (`message.ts`), `init` and `update` (`update.ts`), `view` (`view.ts`), the Subscriptions (`subscriptions.ts`), the Commands (`commands.ts`), and `resources`, the Layer of the app's services (`main.ts`), which `src/entry.ts` hands to Foldkit's runtime.
- The app's declarations, each in a file of its own: its save (`SurvivorsSave`, `save.ts`) and its audio settings (`SurvivorsAudioSettings`, `audio-settings.ts`).
- Its namespaces: what the save keeps of each hero (`HeroRecords`), its sounds (`Sounds`), where its sprite sheet is (`Sheet`), where co-op's rooms are (`Rooms`), and the co-op run's debug read (`CoopDebug`).

## Running it locally

```bash
pnpm dev     # from the repo root, or from this folder; runs `alchemy dev`
```

`alchemy dev` starts Vite's dev server for the site with the Worker in [workerd](https://github.com/cloudflare/workerd) behind it, Durable Objects included, and prints the URL (`http://localhost:1337` unless that port is taken). Single-player and co-op both work there: the page opens its signalling sockets on its own origin, and the Worker answers them. Open the URL in two windows and pick **Co-op** in each.

It needs no Cloudflare account: under `alchemy dev`, `alchemy.run.ts` keeps Alchemy's state in `.alchemy/` (git-ignored) instead of the account. It does need workerd's binary. pnpm skips install scripts unless they're approved, and workerd's binary usually arrives without one, from a package for your platform; if `alchemy dev` reports workerd missing, run `pnpm approve-builds` once, allow `workerd`, and `pnpm install` again.

`VITE_STUN_URLS` in the shell (or `.env.local`) sets the STUN servers (comma-separated; empty for none, as on one machine). The default is a free public one.

`pnpm build` (`vite build`) still builds the static site alone, for a quick check; it has no Worker, so co-op can't find its rooms there.

## Deploying

`alchemy deploy` builds the site with Vite and deploys it, the Worker and the `SignallingRoom` Durable Object namespace. You need a Cloudflare account; the Durable Object class is backed by SQLite, which Workers' free plan allows.

Set these in the environment (or run `pnpm exec alchemy profile create` once and log in interactively instead):

| Variable | What it is |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | An API token that can edit Workers scripts (and read the account), from the Cloudflare dashboard |
| `CLOUDFLARE_ACCOUNT_ID` | The account to deploy into |

Then, from this folder:

```bash
pnpm run plan --stage prod     # what would change
pnpm run deploy --stage prod   # build the site, create or update the Worker and the Durable Object namespace
pnpm run destroy --stage prod  # remove them
```

(`pnpm run deploy`, not `pnpm deploy`, which is a pnpm command of its own.)

The stage defaults to `live_<your user name>`, so a deploy without `--stage` makes a personal copy. When deploying, Alchemy keeps its state in a small state-store Worker in the same Cloudflare account (`Cloudflare.state()`), which it creates on the first deploy, so a deploy from CI sees the same state as one from your machine. The deploy prints the site's `url`; co-op works there with nothing more to configure, over `wss://` on the same host.

## Why one Worker

`Cloudflare.Website.Vite` builds the site with the project's own `vite.config.ts` and uploads it as the Worker's static assets. Its `main` points at `worker/worker.ts`, which exports the `SignallingRoom` Durable Object class and a `fetch` handler, both made by `arcadekit/net/worker` (`SignallingWorker.room`, `SignallingWorker.make`), and `assets.runWorkerFirst` sends only `/host` and `/join/*` to that handler ahead of the files. So the site and the signalling routes share an origin: the client needs no URL setting, no CORS and no second deploy, and `alchemy dev` serves both from one port. (`Cloudflare.Website.Foldkit` derives asset routing from `@foldkit/vite-plugin`'s build metadata; this demo doesn't use that plugin, so it is a plain Vite site.)
