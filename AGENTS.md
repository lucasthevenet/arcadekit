This is arcadekit: primitives for browser games on Effect 4 and Three.js, an entity component system with Effect around it. It publishes `arcadekit` (`packages/arcadekit`), which draws nothing itself, and `@arcadekit/three` (`packages/three`), the plugin that draws a game with Three.js. Use `pnpm` from the repository root.

arcadekit is alpha, with no users to protect, so a better design wins over compatibility. Say what breaks in the changeset, the commit and the PR.

Every session reads this file, so it holds only what every task needs. What one kind of work needs is in a skill, read when the work is of that kind.

## What to read, and when

| The work | Read first |
| --- | --- |
| Code of a package, an example, a benchmark, or a game built on them | The `arcadekit-development` skill, then the branches it selects |
| A test, or showing that a change works | The `test-development` skill |
| A page of the docs site, the site itself, a package's README | The `website-docs` skill |
| The doc comment of an export | The `jsdocs` skill |
| A changeset, a commit of a finished change, a pull request | The `pull-requests` skill |
| Choosing what to build | `ROADMAP.md`, and `roadmap/decisions.md` for what an item waits on |
| An area where things go wrong with no error | Its section of `roadmap/to-revisit.md` |

A skill is `.agents/skills/<name>/SKILL.md`; `.claude/skills` links to the folder.

What arcadekit does is documented in two places and no other: the site's pages, `website/src/content/docs/`, for how and why, and the doc comment of each export, for what it does exactly. A skill says only what a contributor needs beside them, and a README only what its package is. Say a thing once, where its reader looks for it.

## Layout

- `packages/arcadekit/`: `src/<Module>.ts` is the entry `arcadekit/<Module>`, `src/ecs/` the storage core, plain TypeScript with no Effect, and `src/Browser.ts` everything only a page can use. Its `test/`, `examples/` and `bench/` are beside `src/`.
- `packages/three/`: `@arcadekit/three`, laid out the same way.
- `website/`: the docs site. Its pages are in `website/src/content/docs/`, and its reference is made from the packages' doc comments.
- `tooling/`: the workspace's own code. `tooling/lint/` holds the checks: the Oxlint plugin `arcadekit` (`plugin.ts`), which `oxlint.config.ts` turns on, and the checks of the packed packages, `pnpm lint:packages`. `tooling/build/` holds what the build and the tests run. `.changeset/`: pending release notes.
- `ROADMAP.md` and `roadmap/`: what to build next, what it waits on, and what to revisit.

## What every change keeps to

Whatever is in this repository is what the next change copies, whether a person or an agent writes it. Add only what is fit to be copied, and expect to spend most of a change on showing that it works.

- **A check before a sentence.** A rule that matters is held by something that runs: a type, a test, a lint rule in `oxlint.config.ts`, Oxlint's own or one of `tooling/lint/plugin.ts`, or a refusal at run time whose message says what to do instead. Prose, here, in a skill or on a page, is for what no check holds yet. The wording of the docs is the exception: it is never checked by a test or a lint rule.
- **When you are corrected, ask first whether the correction can be a check**, and propose that check, in the same PR when it is small. Apply a single correction to the case it was about. It becomes a line of this file or of a skill only when no check can hold it, and then it says what would.
- **Fix the cause.** A workaround is not a fix, and code that is already here is not precedent for one.
- **Never disable, weaken or skip a check to get a change through**: no `oxlint-disable`, `@ts-ignore`, `it.skip`, a `describe.runIf` that is false in CI, an assertion loosened until it passes, a writer left out of a test's list, or `Bench-slower:` for a slowdown nobody chose. If a check seems wrong, stop and say so in the reply or the PR. A type test's `// @ts-expect-error` is not this.
- **What goes wrong with no error, and that no check can hold yet, is a line of `roadmap/to-revisit.md`**, added in the same commit with what would close it, and taken out by the commit that closes it.
- **No markdown nobody asked for**: no plan, summary or notes file, and no prose to defend a decision or to explain a workaround. Say that in the reply or the PR.

## Verifying

A change is not done until it has been run and shown to work. Reasoning that it should work is not that. Run the narrowest of these that covers the change, and report what could not be run:

| The change | Run |
| --- | --- |
| Any code | `pnpm fix`, then `pnpm check`, `pnpm typecheck`, and the tests that cover it, `pnpm test <file>` |
| The storage core or a query | Also `pnpm --filter arcadekit bench`, and `pnpm --filter arcadekit bench:compare <base checkout>` |
| The loops of `@arcadekit/three` that draw | Also `pnpm --filter @arcadekit/three bench` |
| A package's exports or build, or what a module imports | Also `pnpm build:packages && pnpm lint:packages` |
| `website/`, or a doc comment | `pnpm --filter @arcadekit/website typecheck` and `pnpm build:docs` |

CI runs `pnpm check`, `pnpm test` and `pnpm build`, on a pull request `pnpm build:packages && pnpm lint:packages`, and the `Benchmarks` workflow when the storage core changes. `pnpm check` is formatting plus the Oxlint rules Alchemy and Foldkit lint with: Oxlint's default rules, type-aware, and the Effect rules of `@effect/tsgo`, which `effect-tsgo oxlint` adds to Oxlint. `oxlint.config.ts` says which.

## Issues

Issues live in this repository's GitHub Issues, with the triage labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human` and `wontfix`.
