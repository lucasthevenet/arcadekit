# Co-op findings

What moving co-op into the kit showed that the kit did not take in ([ADR-0019](adr/0019-the-kit-owns-co-op-and-the-app-keeps-the-screens.md)). The survivors demo and grimbonk, a game outside this workspace, each had a copy of the co-op client; the kit now owns it.

A **finding** (see `CONTEXT.md`) is a place where a game had to change, work around, copy or bypass a shared primitive. Each one below names what is copied, where, the layer a fix belongs in, and a verdict, with the same words as [push-puzzle-findings.md](push-puzzle-findings.md).

## Summary

| # | What is copied | Layer | Verdict |
| --- | --- | --- | --- |
| 1 | The two-browser co-op check's helpers | apps | No action |
| 2 | A client test's `Clock` and scheduler | net/testing | No action, until a third copy |
| 3 | The Foldkit glue over the Co-op client | apps | No action |

## No action

### 1. The two-browser co-op check's helpers

- **What:** each app with co-op has one end-to-end check: start its dev server with the signalling worker, open two Chromium pages, host and join, play, and compare state hashes by step. The demo's is `apps/survivor-demo/e2e/coop.e2e.ts`, and grimbonk has its own. Both carry the same helpers: finding Playwright and a Chromium that throttles a hidden tab, starting `alchemy dev` and waiting for its URL, and reading the app's DEV global.
- **Why it stays:** the helpers are tied to each app. They start that app's dev server, click that app's screens and read that app's DEV global, which maps the client's `debug()` to plain data a page can return (the state itself can't cross `page.evaluate`). The kit has no end-to-end check of its own to share them with: it tests its client in Node, on `arcadekit/net/testing`.
- **Verdict:** No action. Shared end-to-end helpers stay in the apps. A kit entry for them would need Playwright and Alchemy as peers, for two callers.

### 2. A client test's `Clock` and scheduler

- **What:** a test that runs a Co-op client under Vitest's fake timers gives Effect a `Clock` that reads the faked `performance.now` and a scheduler that runs on microtasks, about forty lines. The kit's own client tests have them (`packages/arcadekit/src/net/browser/coop-client.test.ts`), and the demo's glue test copies them (`apps/survivor-demo/src/app/coop.test.ts`).
- **Layer:** `arcadekit/net/testing`, beside `fakeCoopRooms` and `manualTicker`.
- **Verdict:** No action yet. The agreed interface of the entry is the three helpers. Grimbonk's tests will be the third copy when it moves to the kit's client; add it then, with the shape all three use.

### 3. The Foldkit glue over the Co-op client

- **What:** each app writes its own Model phases, Messages, Commands and the Subscription that turns the client's events into Messages.
- **Why it stays:** the client already fits `engineEntry` as it is, and the rest follows each app's screens, which differ. ADR-0019 defers a shared module until the copies show its shape.
- **Verdict:** No action.
