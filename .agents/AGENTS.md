This is arcadekit: primitives for browser games on Effect 4, Foldkit and Three.js. It publishes one package, `arcadekit`, with twenty entries; two genre packages and two demo games are built on it. Use `pnpm` from the repository root.

arcadekit is alpha, with no users to protect, so a better design wins over compatibility. Rename, reshape or remove what needs it, exports, stored formats and localStorage keys included, and move every caller and doc in the same change, with no alias, shim or migration. Say what breaks in the changeset, the commit and the PR. Keep the replay and determinism hashes unless changing the simulation's rules is the point.

## Layout

- `packages/arcadekit/src/<entry>/`: an entry's source, and its `README.md`, which is also its page on arcadekit.dev. Its tests, and the helpers only tests import, are in `packages/arcadekit/test/<entry>/`.
- `packages/push-puzzle` and `packages/survivors`: the genre packages. `apps/push-puzzle-demo` and `apps/survivor-demo`: the demos. `apps/docs`: the docs site, built from the entries' READMEs and the glossary.
- `CONTEXT.md`: the glossary. Name things with its words in code, tests and prose, and give a new concept its entry in the same change.
- `tools/lint/` and `oxlint.config.ts`: the kit's own lint rules. Their messages say what to write.
- Inside the package, an entry imports another by relative path to its public file (`../core/index`). The genre packages and the apps import `arcadekit/<entry>`.

## A game is declared

A game is written as declarations: one named class per part, `class LevelSolved extends Game.Event("LevelSolved", { moves: Schema.Int }) {}`, hosted by a Layer or a loop. They are `Game.Event`, `Game.Command`, `Game.Rejection`, `Game.Simulation` (`arcadekit/game`), `Game.Engine` (`arcadekit/game/browser`), `Content`, `Asset` (`arcadekit/content`), `Coop` (`arcadekit/net/browser`), `Save`, `Setting` (`arcadekit/save`) and `CueTable` (`arcadekit/audio`). Push-puzzle and its demo are the example to copy.

- The handlers inside a declaration (`create`, `step`, `apply`, `view`, `input`) are plain functions.
- A run changes only at a step: by its input, and by a command the loop applies at the start of the next step.
- A step gives the same bits on every peer and every replay. Its time comes in as an argument, its randomness from the run's `Rng`, its math from `ExactMath`.
- Code is Effect unless correctness needs it plain: a step, a frame, a lockstep tick, or a host's listener that writes state a frame reads.

## Validation

Run the narrowest check that covers the change. CI runs `pnpm check`, `pnpm test` and `pnpm build`.

| Change | Run |
| --- | --- |
| Any code | `pnpm fix`, then `pnpm check`, `pnpm typecheck`, and `pnpm test <files>` for the tests that cover it |
| A doc comment's example or a README's `ts` block | `pnpm build:packages && pnpm smoke --no-build` |
| A README, `CONTEXT.md` or `apps/docs` | `pnpm build:docs`, which fails on a dead link |
| A step, a simulation's rules or `arcadekit/core` | `pnpm test` for the replay and determinism hashes, and `pnpm test:browsers` |
| The package's exports or its build | `pnpm build:packages && pnpm lint:packages` |

Say which checks you could not run.

## Generated files

- `apps/*/public/sprites/*.png` and `*.json`: `pnpm sprites` (`scripts/generate-sprite-sheets.mjs`).
- `apps/*/public/sounds/*.wav`: `pnpm sounds` (`scripts/generate-placeholder-sounds.mjs`).
- `packages/arcadekit/CHANGELOG.md`: Changesets writes it on release, from `.changeset/`.

## Issues

Issues live in this repository's GitHub Issues, with the triage labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human` and `wontfix`.
