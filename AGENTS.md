arcadekit is a set of primitives for browser games on Effect 4 and Three.js, built as an entity component system with Effect around it. The repository publishes two packages. `arcadekit` (`packages/arcadekit`) draws nothing itself. `@arcadekit/three` (`packages/three`) is the plugin that draws a game with Three.js. arcadekit is alpha.

Run every command with `pnpm` from the repository root.

## Layout

- `packages/arcadekit/`: the `arcadekit` package.
  - `src/<Module>.ts` is the entry `arcadekit/<Module>`.
  - `src/net/` holds the modules of `arcadekit/net`, for games that several machines play.
  - `src/ecs/` is the storage core, in plain TypeScript with no Effect.
  - `src/browser/` holds what only a page can use, the entry `arcadekit/browser`. Each PascalCase module there is an entry `arcadekit/browser/<Module>`. `internal/` is not an entry.
  - `test/` and `bench/` sit beside `src/`.
- `packages/three/`: the `@arcadekit/three` package, with the same layout.
- `examples/`: the examples. Each one is a private workspace package with its code in `src/`. It imports `arcadekit` and `@arcadekit/three` by their entries, as a game does. The examples are `demo`, `duel`, `page`, `three`, `relay` and `relay-cloudflare`.
- `website/`: the docs site. Its pages are in `website/src/content/docs/`. The reference is generated from the packages' doc comments. `website/README.md` says how the site works.
- `tooling/lint/`: the Oxlint plugin `arcadekit` (`plugin.ts`), which `oxlint.config.ts` turns on, and the checks of the packed packages (`packages.sh`).
- `tooling/build/`: the files that the build and the tests run.
- `.changeset/`: pending release notes.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm install` | Install dependencies |
| `pnpm fix` | Format, and apply the lint fixes |
| `pnpm check` | Check formatting and lint with Oxlint |
| `pnpm typecheck` | Type-check the packages, their benchmarks, the examples, the docs site and `tooling/` |
| `pnpm test` | Run all tests with Vitest |
| `pnpm test <file>` | Run one test file |
| `pnpm build` | Type-check, build the packages, and build the docs site |
| `pnpm build:packages` | Build `arcadekit` and `@arcadekit/three` into `dist/` |
| `pnpm lint:packages` | Check the packed packages, after `pnpm build:packages` |
| `pnpm dev:docs` | Serve the docs site |
| `pnpm build:docs` | Build the docs site, which fails on a dead link |
| `pnpm --filter @arcadekit/website typecheck` | Build the packages and compile the code on the site's pages |
| `pnpm changeset` | Add a release note |

Benchmarks:

| Command | What it measures |
| --- | --- |
| `pnpm --filter arcadekit bench` | The storage core and its accessors |
| `pnpm --filter arcadekit bench:compare <base checkout>` | The storage core against another checkout |
| `pnpm --filter arcadekit bench:compare <base checkout> --suite app` | The cost of an app's stages against another checkout |
| `pnpm --filter arcadekit bench:parallel` | Loops shared between workers |
| `pnpm --filter @arcadekit/three bench` | The loops of `@arcadekit/three` that draw |
| `pnpm --filter @arcadekit/three bench:compare <base checkout>` | Those loops against another checkout |

Examples:

| Command | What it runs |
| --- | --- |
| `pnpm --filter @arcadekit/example-<folder> start` | The example in `examples/<folder>` |
| `pnpm --filter @arcadekit/example-relay check <address>` | A check of a relay at that address |

## CI

On a pull request, and on a push to `main` or `next`:

- `ci.yml` runs `pnpm check`, `pnpm test` and `pnpm build`.
- `package-checks.yml` runs `pnpm build:packages && pnpm lint:packages`.

On a pull request only:

- `bench.yml` runs `bench:compare` for the storage core and for an app's stages when the source or the benchmarks of `arcadekit` change. It compares each against the branch that the pull request targets.

## Issues

Issues are in this repository's GitHub Issues, labelled `bug`, `feature` or `docs`. The roadmap is [#173](https://github.com/lucasthevenet/arcadekit/issues/173).
