---
name: website-docs
description: How the docs site is written. Use when adding or changing a page of the docs site under `website/` (the walkthrough, a concept, a guide), the site itself, or a package's README.
---

The documentation is in two places, and a thing is said in one of them and linked from the other:

| What | Where | Is |
| --- | --- | --- |
| The walkthrough, the concepts, the guides | `website/src/content/docs/` | The site's own pages: how and why a game's author uses a part, the rules to follow, and what goes wrong |
| A module's reference | Its doc comments | A page of the site for each module: exactly what each export does. Written with the `jsdocs` skill, not this one |

A package's README is neither. It is what GitHub and npm show: a sentence or two on what the package is, how to install it, and links to the site. It explains nothing, and what would be said there is said on a page. What is not built yet is on the site's `website/src/content/docs/not-done-yet.md`, under the area it belongs to.

## Workflow

1. Decide which of these the change is. `website/README.md` says how the site works, a section for each task. Read the section the change needs, found with `grep -n '^##' website/README.md`, and no other:
   - a new page, or where it is listed: "A new page";
   - a `ts` block on a page: "The code on a page";
   - a link: "Links";
   - how a module's page is made from its doc comments: "The reference of a module";
   - the site's look, its images, or deploying it: the section of that name.
2. Write it:
   - Name things as the site's concepts and guides already name them. They are the map of what a game's author sees.
   - A `ts` block of a page is a whole program and is compiled; a block titled `*.test.ts` is run. Mark a block that is not whole `ts sketch`.
   - A page links to another page by its relative path, to the reference by its address on the site (`/reference/arcadekit/Sound`), and to any other file of the repository by its relative path.
   - No page of the site mentions the roadmap, which is the repository's and not the docs'.
   - A sentence that begins "it is the game's to" is something the code does not stop: it also gets a line of [to-revisit.md](../../../roadmap/to-revisit.md).
   - A guide that passes 12 KB is probably two: split it, and name the new page in `OUTLINE` of `website/src/lib/sidebar.ts`, which a test holds every guide to.
   - No doc sentence explains a workaround or why the right thing was not done.
3. Run `pnpm fix`, then `pnpm --filter @arcadekit/website typecheck`, which builds the packages and compiles the pages' code, and `pnpm build:docs`, which fails on a dead link. To look at a page, `pnpm dev:docs`; restart it after adding a page.

The task is complete when the change is said in one place, the two commands pass or are reported as not run, and a page whose look changed has been looked at.
