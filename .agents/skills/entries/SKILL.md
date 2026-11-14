---
name: entries
description: Package entries. Use when adding, renaming or removing an entry of arcadekit, changing which entries or packages an entry may import, or writing an entry's README.
---

arcadekit is one package (`packages/arcadekit`) whose entries live in `src/<entry>/`, each with a public file (`index.ts`) that the package's `exports` names.

## Adding an entry

1. Add `src/<entry>/index.ts`, and its subpath to `exports` in `packages/arcadekit/package.json`, with `source`, `types` and `default` conditions. The build (`tsdown.config.ts`) reads its entries from that map.
2. Say which packages it may import in `ENTRY_PACKAGES` (`packages/arcadekit/test/entry-packages.test.ts`), and keep it to the direction below. A new import between entries or a new package is a design decision: say why in the PR.
3. Write its `README.md`: its import path as the heading (`# arcadekit/net/testing`), then a paragraph. It is a page of arcadekit.dev, and [`website/README.md`](../../../website/README.md) says what else a page needs. Add its folder to `ENTRIES` in `scripts/smoke-test.mjs`, which compiles the README's `ts` blocks.
4. Add it to the tables of entries in `README.md` and `packages/arcadekit/README.md`, and to the glossary's **Entry** count.

Removing or renaming an entry undoes the same places.

## What an entry may import

- Entries import in one direction: `core`, `input`, `content`, `save`, `audio` and `render-three` import no other entry; `game` imports `core`; `net` imports `core` and `game`; `foldkit` imports `game`. A sub-entry (`net/browser`) counts as its group, and an entry's tests keep its direction.
- Inside the package, an entry imports another by relative path to its public file (`../core/index`), never as `arcadekit/core` and never a file behind it, so the source, the build and the published files reach the same module. A file of `src/` imports nothing of `test/`.
- `arcadekit/game/browser` has everything `arcadekit/game` has plus the engine, so a file imports one of the two, as `Game`.
- `arcadekit/net/worker` is the one entry that runs on Cloudflare: `tsconfig.worker.json` checks it with Workers types and no DOM, and no other entry may import `cloudflare:workers`.
- The `./testing` entries and `arcadekit/game/scenario` are imported only by tests. One that runs in Node may import a `node:` built-in, listed in the entry-packages test's `NODE_ENTRIES`: `arcadekit/render-three/testing`, which `tsconfig.node.json` checks.

## An entry's README

It is read on GitHub, on npm and on arcadekit.dev. Its `ts` blocks are small games of their own, which `pnpm smoke` compiles alone. Its links are relative links to the repository's files, or full GitHub URLs for files the npm package doesn't have; the site rewrites both, and `pnpm build:docs` fails on a dead one.
