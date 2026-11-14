This is arcadekit: primitives for browser games on Effect 4, Foldkit and Three.js. It publishes one package, `arcadekit`, with twenty entries; two demo games are built on it, each with its genre's code inside it. Use `pnpm` from the repository root.

arcadekit is alpha, with no users to protect, so a better design wins over compatibility. Rename, reshape or remove what needs it, exports, stored formats and localStorage keys included, and move every caller and doc in the same change, with no alias, shim or migration. Say what breaks in the changeset, the commit and the PR. Keep the replay and determinism hashes unless changing the simulation's rules is the point.

## Layout

- `packages/arcadekit/src/<entry>/`: an entry's source, and its `README.md`, which is also its reference page on arcadekit.dev: what the entry has. Its doc comments are the rest of its reference, a page for each module. Its tests, and the helpers only tests import, are in `packages/arcadekit/test/<entry>/`.
- `examples/push-puzzle-demo` and `examples/survivor-demo`: the demos, each with its genre in `src/<genre>/` beside its Foldkit app in `src/app/`. `website`: the docs site, built from `docs/`, the entries' READMEs and the glossary.
- `docs/`: how to use the kit, by task rather than by entry: the walkthrough (`making-a-game.md`), `concepts/`, `guides/` and `testing/`, each file a page of arcadekit.dev. A change to what an entry does changes the guide that shows it too.
- `CONTEXT.md`: the glossary. Name things with its words in code, tests and prose, and give a new concept its entry in the same change.
- `tools/lint/` and `oxlint.config.ts`: the kit's own lint rules. Their messages say what to write.
- Inside the package, an entry imports another by relative path to its public file (`../core/index`). The demos import `arcadekit/<entry>`, and their genre the same way as an entry: by relative path to its public file (`../push-puzzle/index`, `../push-puzzle/browser/index`).

## A game is declared

A game is written as declarations: one named class per part, `class LevelSolved extends Game.Event("LevelSolved", { moves: Schema.Int }) {}`, hosted by a Layer or a loop. They are `Game.Event`, `Game.Command`, `Game.Rejection`, `Game.Simulation` (`arcadekit/game`), `Game.Engine` (`arcadekit/game/browser`), `Content`, `Asset` (`arcadekit/content`), `Coop` (`arcadekit/net/browser`), `Save`, `Setting` (`arcadekit/save`) and `CueTable` (`arcadekit/audio`). Every other module of a game is a namespace. The push-puzzle demo is the example to copy.

- The handlers inside a declaration (`create`, `step`, `apply`, `view`, `input`) are plain functions.
- A run changes only at a step: by its input, and by a command the loop applies at the start of the next step.
- A step gives the same bits on every peer and every replay. Its time comes in as an argument, its randomness from the run's `Rng`, its math from `ExactMath`.
- Code is Effect unless correctness needs it plain: a step, a frame, a lockstep tick, or a host's listener that writes state a frame reads.

## Validation

Run the narrowest check that covers the change. CI runs `pnpm check`, `pnpm test` and `pnpm build`.

| Change | Run |
| --- | --- |
| Any code | `pnpm fix`, then `pnpm check`, `pnpm typecheck`, and `pnpm test <files>` for the tests that cover it |
| A doc comment's example, or a `ts` block of a README or of `docs/` | `pnpm build:packages && pnpm smoke --no-build` |
| A README, a page of `docs/`, a doc comment, `CONTEXT.md` or `website` | `pnpm build:docs`, which fails on a dead link |
| A step, a simulation's rules or `arcadekit/core` | `pnpm test` for the replay and determinism hashes, and `pnpm test:browsers` |
| The package's exports or its build | `pnpm build:packages && pnpm lint:packages` |

Say which checks you could not run.

## Generated files

- `examples/*/public/sprites/*.png` and `*.json`: `pnpm sprites` (`scripts/generate-sprite-sheets.mjs`).
- `examples/*/public/sounds/*.wav`: `pnpm sounds` (`scripts/generate-placeholder-sounds.mjs`).
- `packages/arcadekit/CHANGELOG.md`: Changesets writes it on release, from `.changeset/`.

## Issues

Issues live in this repository's GitHub Issues, with the triage labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human` and `wontfix`.
