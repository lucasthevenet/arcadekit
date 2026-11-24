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
| Choosing what to build | The roadmap, issue [#173](https://github.com/lucasthevenet/arcadekit/issues/173), and the issue of the item |
| An area where things go wrong with no error | The open issues labelled `silent-failure`, listed by area in the roadmap |

A skill is `.agents/skills/<name>/SKILL.md`; `.claude/skills` links to the folder.

What arcadekit does is documented in two places and no other: the site's pages, `website/src/content/docs/`, for how and why, and the doc comment of each export, for what it does exactly. A skill says only what a contributor needs beside them, and a README only what its package is. Say a thing once, where its reader looks for it.

## Layout

- `packages/arcadekit/`: `src/<Module>.ts` is the entry `arcadekit/<Module>`, `src/net/` the modules of `arcadekit/net`, what several machines play with, `src/ecs/` the storage core, plain TypeScript with no Effect, and `src/browser/` everything only a page can use: `Browser.ts`, the entry `arcadekit/Browser`, other PascalCase modules, each an entry `arcadekit/browser/<Module>`, and `internals/`, which is no entry. Its `test/`, `examples/` and `bench/` are beside `src/`.
- `packages/three/`: `@arcadekit/three`, laid out the same way.
- `website/`: the docs site. Its pages are in `website/src/content/docs/`, and its reference is made from the packages' doc comments.
- `tooling/`: the workspace's own code. `tooling/lint/` holds the checks: the Oxlint plugin `arcadekit` (`plugin.ts`), which `oxlint.config.ts` turns on, and the checks of the packed packages, `pnpm lint:packages`. `tooling/build/` holds what the build and the tests run. `.changeset/`: pending release notes.

## What every change keeps to

Whatever is in this repository is what the next change copies, whether a person or an agent writes it. Add only what is fit to be copied, and expect to spend most of a change on showing that it works.

- **A check before a sentence, in the packages.** A rule about what a published package does, or how its source is written, is held first by a design that leaves no room to break it, and otherwise by something that runs: a type, a test, a lint rule in `oxlint.config.ts`, Oxlint's own or one of `tooling/lint/plugin.ts`, or a refusal at run time, each with a message that says what to do instead. Prose, here, in a skill or on a page, is for what no check holds yet.
- **When you are corrected on the packages' source, ask first whether a design can rule the mistake out or a check can catch it**, and propose that change, in the same PR when it is small. Apply a single correction to the case it was about. It becomes a line of this file or of a skill only when no check can hold it, and then it says what would.
- **Fix the cause**, even when it is a larger change. A workaround is not a fix, and code that is already here is not precedent for one.
- **Never disable, weaken or skip a check to get a change through**: no `oxlint-disable`, `@ts-ignore`, `it.skip`, a `describe.runIf` that is false in CI, an assertion loosened until it passes, a writer left out of a test's list, or `Bench-slower:` for a slowdown nobody chose. If a check seems wrong, stop and say so in the reply or the PR. A type test's `// @ts-expect-error` is not this.
- **What goes wrong with no error, and that no check can hold yet, is an issue labelled `silent-failure`**, filed with the change that finds it, saying what would close it, a sub-issue of the roadmap listed under its area, and closed by the PR that closes it.
- **No markdown nobody asked for**: no plan, summary, notes or to-do file, and no prose to defend a decision or to explain a workaround. Say that in the reply or the PR. Work left for later is an issue, below.

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

Whatever is found and left to fix later is an issue, filed when it is left and named in the PR that leaves it: a bug, a debt, a departure from a skill, or a thing that goes wrong with no error. A feature not built yet is a line under its area of the roadmap's "Not built yet" until it is work of its own, and then an issue. None of it is ever a markdown file of the repository, a list in a skill, or a `TODO` in the code. The roadmap is [#173](https://github.com/lucasthevenet/arcadekit/issues/173): what to build next, in order, and what to close before a stable release, as its sub-issues, and what is not built yet, by area, in its description.
