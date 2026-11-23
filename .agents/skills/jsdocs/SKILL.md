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

The prose follows pstack's [`technical-writing`](https://github.com/cursor/plugins/blob/main/pstack/skills/technical-writing/SKILL.md) skill for reference, and names things as the site's concepts and guides name them.

The wording of a doc comment is for whoever writes and reviews it. Prose is not checked by automated tests: do not add a test or a lint rule for wording.

The task is complete when every changed public declaration satisfies each applicable reference, has a `@category` of the list, reads right on its page, and the checks above pass or are reported as not run.

What the reference reads of a doc comment is defined in `website/src/lib/api.ts`.
