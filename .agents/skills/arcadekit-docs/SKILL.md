---
name: arcadekit-docs
description: How arcadekit's documentation is written. Use when adding or changing a page of the docs site under `website/`, the site itself, a package's README, or the doc comments the reference is made from.
---

The documentation is in three places, and a thing is said in one of them and linked from the others:

| What | Where | Is |
| --- | --- | --- |
| The walkthrough, the concepts, the guides | `website/src/content/docs/` | The site's own pages: what a game's author reads first |
| A module's reference | Its doc comments, in `packages/<package>/src/<Module>.ts` | A page of the site for each module, made from the built declarations |
| A package's README | `packages/arcadekit/README.md`, `packages/three/README.md` | What GitHub and npm show: the design, each part, and "Not done yet". Not a page of the site |

## Workflow

1. Decide which of the three the change is. `website/README.md` says how the site works, a section for each task. Read the section the change needs, found with `grep -n '^##' website/README.md`, and no other:
   - a new page, or where it is listed: "A new page";
   - a `ts` block on a page: "The code on a page";
   - a doc comment, a `@category`, or how a module's page is laid out: "The reference of a module";
   - a link: "Links";
   - the site's look, its images, or deploying it: the section of that name.
2. Write it:
   - Name things as the READMEs and the site's concepts and guides already name them. They are the map of what a game's author sees.
   - A `ts` block of a page is a whole program and is compiled; a block titled `*.test.ts` is run. Mark a block that is not whole `ts sketch`.
   - A page links to another page by its relative path, to the reference by its address on the site (`/reference/arcadekit/Sound`), and to any other file of the repository by its relative path.
   - No page of the site mentions the roadmap, which is the repository's and not the docs'.
   - A README says what a part does and, under "Not done yet", what it does not. A sentence that begins "it is the game's to" is something the code does not stop: it also gets a line of [to-revisit.md](../../../roadmap/to-revisit.md).
   - No doc sentence explains a workaround or why the right thing was not done.
3. Run `pnpm fix`, then `pnpm --filter @arcadekit/website typecheck`, which builds the packages and compiles the pages' code, and `pnpm build:docs`, which fails on a dead link. To look at a page, `pnpm dev:docs`; restart it after adding a page or changing a doc comment.

The task is complete when the change is said in one place, the two commands pass or are reported as not run, and a page whose look changed has been looked at.
