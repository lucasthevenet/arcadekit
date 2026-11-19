---
name: website-docs
description: How the docs site is written. Use when adding or changing a page of the docs site under `website/` (the walkthrough, a concept, a guide), the site itself, or a package's README.
---

The documentation is in two places, and a thing is said in one of them and linked from the other:

| What | Where | Is |
| --- | --- | --- |
| The walkthrough, the concepts, the guides | `website/src/content/docs/` | The site's own pages: how and why a game's author uses a part, the rules to follow, and what goes wrong |
| A module's reference | Its doc comments | A page of the site for each module: exactly what each export does. Written with the `jsdocs` skill, not this one |

A package's README is neither. It is what GitHub and npm show: a sentence or two on what the package is, how to install it, and links to the site. It explains nothing, and what would be said there is said on a page. The site describes arcadekit as it is today. What is not built yet goes under its area in `ROADMAP.md`'s "Not built yet", and what was removed or changed goes in the changeset: neither is on a page or in a doc comment.

## Workflow

1. Decide which of these the change is. `website/README.md` says how the site works, a section for each task. Read the section the change needs, found with `grep -n '^##' website/README.md`, and no other:
   - a new page, or where it is listed: "A new page";
   - a `ts` block on a page: "The code on a page";
   - a link: "Links";
   - how a module's page is made from its doc comments: "The reference of a module";
   - the site's look, its images, or deploying it: the section of that name.
2. Write it to these rules:
   - Open a page with what the thing is and what it is for, the term in bold: "A **system** is ...".
   - Address the reader as "you", and say what the library does in the present tense and the active voice.
   - Use the words a TypeScript developer already knows: "defaults to", "interpolate", "release", "read-only", "requires", "is responsible for". Not coined phrasing such as "when left out", "let go", "only reads" or "is the game's to".
   - Keep sentences short and direct: one fact per sentence, the subject first, no inverted or archaic constructions ("Of a frame's three stages it is in the first").
   - Describe arcadekit as it is: no history of what it once did, no plans, and no comparison with other libraries to justify a design.
   - Give a section a heading that names its task or its subject ("Defining a component", "Field types"), show the code, then explain it.
   - Put options in a table with their defaults, and caveats in a list where the reader meets them.
   - Name things as the site's concepts and guides already name them. They are the map of what a game's author sees.
   - A `ts` block of a page is a whole program and is compiled; a block titled `*.test.ts` is run. Mark a block that is not whole `ts sketch`.
   - A page links to another page by its relative path, to the reference by its address on the site (`/reference/arcadekit/Sound`), and to any other file of the repository by its relative path.
   - No page of the site mentions the roadmap, which is the repository's and not the docs'.
   - A sentence that makes the game responsible for something ("your game must", "you are responsible for") is something the code does not stop: it also gets a line of [to-revisit.md](../../../roadmap/to-revisit.md).
   - A guide that passes 12 KB is probably two: split it, and name the new page in `OUTLINE` of `website/src/lib/sidebar.ts`, which a test holds every guide to.
   - No doc sentence explains a workaround or why the right thing was not done.

   These rules are for whoever writes and reviews the page. Prose is not checked by automated tests: do not add a test or a lint rule for wording.

3. Run `pnpm fix`, then `pnpm --filter @arcadekit/website typecheck`, which builds the packages and compiles the pages' code, and `pnpm build:docs`, which fails on a dead link. To look at a page, `pnpm dev:docs`; restart it after adding a page.

The task is complete when the change is said in one place, the two commands pass or are reported as not run, and a page whose look changed has been looked at.
