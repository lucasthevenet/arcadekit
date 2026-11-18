---
name: jsdocs
description: Public API doc comments. Use when authoring or reviewing the doc comment of an export of `packages/arcadekit` or `packages/three`, refining a module's documentation, or changing what a module's reference page says.
---

A module's page of the reference is made from its doc comments and from nothing else, and an editor shows the same text in a tooltip. Every export has one.

## Workflow

1. Inspect the declaration, implementation, nearby doc comments, tests, and call sites.
2. Select every applicable branch and load its reference before editing:
   - a declaration's comment, a module's, or a tag: [declarations.md](declarations.md);
   - categories: [categories.md](categories.md);
   - examples: [examples.md](examples.md).
3. Make a focused API fix or module refinement. Preserve verified facts and valuable examples rather than rewriting mechanically.
4. For module refinement or APIs with close alternatives, say which to use when, and inspect implementation and tests for concrete `**Gotchas**`.
5. Run `pnpm fix`, then `pnpm --filter @arcadekit/website typecheck` and `pnpm build:docs`, which build the packages and make each module's page from the built declarations. Read the page the change is on, `/reference/<package>/<Module>` under `pnpm dev:docs`, restarted after the change.

`@internal` declarations are left off the reference, and are outside public doc comment authoring: a line that says what the export is for is enough.

Public declarations use a multiline block with one self-contained practical description paragraph. Start functions and methods with a present-tense action; match nearby noun-family phrasing for values. Name things as the site's concepts and guides name them. Optional non-empty sections appear once in this order: `**When to use**`, `**Details**`, `**Gotchas**`. Separate descriptions, sections, examples, and tags with one blank line. `**When to use**` states a positive use case distinct from the description; reserve `**Gotchas**` for concrete caveats and failure modes.

The task is complete when every changed public declaration satisfies each applicable reference, has a `@category` of the list, reads right on its page, and the checks above pass or are reported as not run.

Adapted from the [`jsdocs` skill of Effect](https://github.com/Effect-TS/effect/tree/main/.agents/skills/jsdocs) (MIT), and fitted to what this repository's reference reads: `website/src/lib/api.ts`.
