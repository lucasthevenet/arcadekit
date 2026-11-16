This is arcadekit: primitives for browser games on Effect 4, Foldkit and Three.js. It publishes one package, `arcadekit`, from `packages/arcadekit`, with an entry for every module (`arcadekit/App`, `arcadekit/Input` and so on), `arcadekit` for all of them together, `arcadekit/Browser` for what only a page can use, and `arcadekit/ecs`. Use `pnpm` from the repository root.

This branch is a revamped version, designed fresh: an entity component system with Effect around it. `packages/arcadekit/README.md` describes the design, what works and what is not done yet; read it first. It is a first cut, with no Foldkit or Three.js integration yet. The previous version on `main` is not a reference for this one.

Before writing code, read `docs/conventions.md`: how code here is written so that it stays Effect code, with references into Effect's documentation for each pattern. `docs/roadmap.md` says what to build next and in what order.

arcadekit is alpha, with no users to protect, so a better design wins over compatibility. Say what breaks in the changeset, the commit and the PR.

## Layout

- `packages/arcadekit/src/`: the package's source. Each subpath of its `package.json` `exports` names its source file under a `source` condition, and its built files as `./dist/<name>.d.ts` and `./dist/<name>.js`; `tsdown.config.ts` builds every export from that map, and generates the declarations with the TypeScript compiler (`tsgo`), so an export's type may be inferred.
- A module's file is named in PascalCase after the namespace it is imported as, as Effect's own are: `src/App.ts` is `App`, `src/TickScheduler.ts` holds `TickScheduler`. The files of `src/ecs/` and `index.ts` are lower case.
- Every module is an entry: `src/App.ts` is `arcadekit/App`. `src/index.ts` is the `arcadekit` entry, which gives them all but `Browser`. Each imports Effect and nothing else, and names nothing that only a page has. `src/Browser.ts` is the `arcadekit/Browser` entry: everything only a page can use, and the one import of a browser package. `src/ecs/index.ts` is the `arcadekit/ecs` entry. A new module gets its entry in `package.json` with it.
- `packages/arcadekit/src/ecs/`: the storage core (components, tables, queries, the command buffer). It is plain synchronous TypeScript and imports nothing from Effect.
- `packages/arcadekit/test/`: its tests, run by Vitest from the source with no build.
- `packages/arcadekit/examples/` and `packages/arcadekit/bench/`: two example games and a benchmark, run with `pnpm --filter arcadekit demo`, `duel` and `bench`, and a game in a page, `examples/page/`, served by `pnpm --filter arcadekit page`. They are type-checked by `tsconfig.examples.json` and are not published.
- `docs/`: the conventions and the roadmap.
- `scripts/`: the workspace's helpers (the `source` condition for Vite and Vitest, and the package lint).
- `.changeset/`: pending release notes; see its README.

## Rules the design depends on

- A system is one Effect per tick with plain loops inside. Code that runs once per entity is never an Effect: measured, that is about 25 times slower than a loop over columns.
- Nothing changes the set of entities or their components while a query is iterating. Such changes go through `Commands` and are applied when the system finishes.
- A tick gives the same result from the same inputs. Time comes from `Time`, waiting from `Script`, and fibers only resume when the tick flushes its scheduler.
- What draws the game runs in the frame stage, between ticks, and never changes the world: a game that is drawn is the same game as one that is not.
- What the devices say reaches the game as actions, issued in the input stage before a tick and logged like any other: a replay reads no device.

## Validation

CI runs `pnpm check`, `pnpm test` and `pnpm build`. For any code change run `pnpm fix`, then `pnpm check`, `pnpm typecheck` and the tests that cover it. `pnpm check` is formatting plus oxlint's default rules; there are no style rules. For a change to the storage core or to a query, also run `pnpm --filter arcadekit bench`. For a change to the package's exports or its build, or to what a module imports, run `pnpm build:packages && pnpm lint:packages`, which also checks what each built entry imports. Say which checks you could not run.

## Issues

Issues live in this repository's GitHub Issues, with the triage labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human` and `wontfix`.
