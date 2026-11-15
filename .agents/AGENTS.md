This is arcadekit: primitives for browser games on Effect 4, Foldkit and Three.js. It publishes one package, `arcadekit`, from `packages/arcadekit`. Use `pnpm` from the repository root.

This branch is a revamped version, designed fresh: an entity component system with Effect around it. `packages/arcadekit/README.md` describes the design, what works and what is not done yet; read it first. It is a first cut, with no Foldkit or Three.js integration yet. The previous version on `main` is not a reference for this one.

arcadekit is alpha, with no users to protect, so a better design wins over compatibility. Say what breaks in the changeset, the commit and the PR.

## Layout

- `packages/arcadekit/src/`: the package's source. Each subpath of its `package.json` `exports` names its source file under a `source` condition, and its built files as `./dist/<name>.d.ts` and `./dist/<name>.js`; `tsdown.config.ts` builds every export from that map.
- `packages/arcadekit/src/ecs/`: the storage core (components, tables, queries, the command buffer). It is plain synchronous TypeScript and imports nothing from Effect.
- `packages/arcadekit/test/`: its tests, run by Vitest from the source with no build.
- `packages/arcadekit/examples/` and `packages/arcadekit/bench/`: two example games and a benchmark, run with `pnpm --filter arcadekit demo`, `duel` and `bench`. They are type-checked by `tsconfig.examples.json` and are not published.
- `scripts/`: the workspace's helpers (the `source` condition for Vite and Vitest, and the package lint).
- `.changeset/`: pending release notes; see its README.

## Rules the design depends on

- A system is one Effect per tick with plain loops inside. Code that runs once per entity is never an Effect: measured, that is about 25 times slower than a loop over columns.
- Nothing changes the set of entities or their components while a query is iterating. Such changes go through `Commands` and are applied when the system finishes.
- A tick gives the same result from the same inputs. Time comes from `Time`, waiting from `Script`, and fibers only resume when the tick flushes its scheduler.
- An error class or a service is declared as a typed constant plus a class that extends it, because the build generates declarations one file at a time (`isolatedDeclarations`). `src/services.ts` and `src/tagged-error.ts` show the pattern.

## Validation

CI runs `pnpm check`, `pnpm test` and `pnpm build`. For any code change run `pnpm fix`, then `pnpm check`, `pnpm typecheck` and the tests that cover it. `pnpm check` is formatting plus oxlint's default rules; there are no style rules. For a change to the storage core or to a query, also run `pnpm --filter arcadekit bench`. For a change to the package's exports or its build, run `pnpm build:packages && pnpm lint:packages`. Say which checks you could not run.

## Issues

Issues live in this repository's GitHub Issues, with the triage labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human` and `wontfix`.
