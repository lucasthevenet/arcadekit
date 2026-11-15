This is arcadekit: primitives for browser games on Effect 4, Foldkit and Three.js. It publishes one package, `arcadekit`, from `packages/arcadekit`. Use `pnpm` from the repository root.

This branch is a blank slate for a revamped version: the package has its build and publish setup and no source yet. Design it fresh.

arcadekit is alpha, with no users to protect, so a better design wins over compatibility. Say what breaks in the changeset, the commit and the PR.

## Layout

- `packages/arcadekit/src/`: the package's source. Each subpath of its `package.json` `exports` names its source file under a `source` condition, and its built files as `./dist/<name>.d.ts` and `./dist/<name>.js`; `tsdown.config.ts` builds every export from that map.
- `packages/arcadekit/test/`: its tests, run by Vitest from the source with no build.
- `scripts/`: the workspace's helpers (the `source` condition for Vite and Vitest, and the package lint).
- `.changeset/`: pending release notes; see its README.

## Validation

CI runs `pnpm check`, `pnpm test` and `pnpm build`. For any code change run `pnpm fix`, then `pnpm check`, `pnpm typecheck` and the tests that cover it. For a change to the package's exports or its build, run `pnpm build:packages && pnpm lint:packages`. Say which checks you could not run.

## Issues

Issues live in this repository's GitHub Issues, with the triage labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human` and `wontfix`.
