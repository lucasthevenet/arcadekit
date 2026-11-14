# The demo's Worker

`worker.ts` is the survivors demo's whole Cloudflare Worker: it serves the demo's files and is co-op's signalling worker. The signalling worker is the kit's, [`arcadekit/net/worker`](../../../packages/arcadekit/src/net/worker/README.md), whose README has the protocol, the limits and the code. This file only names the Durable Object class (`SignallingRoom`) and the two bindings (`ROOMS`, `ASSETS`) that the demo's `alchemy.run.ts` declares.

`alchemy dev` runs it locally beside the site, and `alchemy deploy` deploys both; see [the demo's README](../README.md). `pnpm typecheck` checks this folder and `alchemy.run.ts` against Cloudflare's Workers types and Alchemy's API (`tsconfig.worker.json`). The co-op end-to-end test (`pnpm test:e2e`) plays through it.
