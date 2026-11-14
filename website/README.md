# Docs site

The arcadekit docs, [arcadekit.dev](https://arcadekit.dev): an [Astro](https://astro.build) site with the [Starlight](https://starlight.astro.build) theme, whose pages are the repository's own text, read where it is: its markdown, and the package's doc comments. No file is copied, so there is one text to keep right.

The docs are laid out as [Effect's](https://effect.website/docs) and [Alchemy's](https://alchemy.run) are, in three topics, each with a sidebar of its own ([starlight-sidebar-topics](https://starlight-sidebar-topics.netlify.app)):

- **Learn**: getting started, the walkthrough, the concepts and the games built on the kit.
- **Guides**: a guide for each task, whichever entries it takes, and testing.
- **Reference**: a page for each entry, and one for each of its modules, with every export's signature and doc comment, generated from the source.

| Address | File |
| --- | --- |
| `/` | [`src/content/docs/index.mdx`](src/content/docs/index.mdx), which includes [the package's README](../packages/arcadekit/README.md) after its title and first paragraph |
| `/<path>`, such as `/making-a-game`, `/concepts/lockstep` and `/guides/sprites` | `docs/<path>.md`: the walkthrough, the concepts, the guides and testing |
| `/reference/<entry>`, such as `/reference/core` and `/reference/net/browser` | `packages/arcadekit/src/<entry>/README.md`, which npm shows too, then the entry's own exports. An entry with no README has its public file's module comment instead |
| `/reference/<entry>/<module>`, such as `/reference/core/rng` | The module the entry exports as a namespace, `packages/arcadekit/src/core/rng.ts`: its module comment, then its exports |
| `/glossary` | [`CONTEXT.md`](../CONTEXT.md), with each term as a heading |

```bash
pnpm dev:docs     # from the repo root: Astro's dev server, which reloads a page as a file it is made from changes
pnpm build:docs   # build the site to website/dist; `pnpm build` runs it too
pnpm --filter @arcadekit/website preview   # serve the built site
```

## A new page

A file under [`docs/`](../docs) is a page as soon as it exists, and so are a new entry and a new module: [`src/lib/pages.ts`](src/lib/pages.ts) finds every markdown file under `docs/`, and every entry of the package's `exports` with the modules it exports, and serves `docs/guides/sprites.md` at `/guides/sprites`, `arcadekit/net/testing` at `/reference/net/testing` and its `FakeCoopRooms` at `/reference/net/testing/fake-coop-rooms`. The pages are found when the site starts, so restart `pnpm dev:docs` after adding one.

Every page of `docs/` and every README starts with a `# ` heading, its title, then a paragraph. The sidebar lists the page by its title, and the paragraph is its description under a shared link. A file that doesn't start with a `# ` heading fails the build. An entry's README is titled with its import path, `# arcadekit/net/testing`, or `pnpm test` fails ([`src/lib/pages.test.ts`](src/lib/pages.test.ts)). A README with no entry of the package's `exports` fails the build.

A `ts` block of a page is compiled by the smoke test ([`scripts/smoke-test.mjs`](../scripts/smoke-test.mjs)), alone, as a small program of its own: every block under `docs/`, and those of the READMEs in its `ENTRIES`, so add a new entry's folder there. A sketch, with `/* … */` where a game's own code goes, is fenced ` ```ts sketch `: it is highlighted as TypeScript and nothing compiles it.

[`src/lib/sidebar.ts`](src/lib/sidebar.ts) places each page in its topic. Its `OUTLINE` names the guides and concepts in order, in groups: a page it doesn't name goes at the end of its folder's group, so a new concept is listed at the end of Concepts and a new guide under Guides' "More" until the outline places it, and a page the outline names that doesn't exist fails the build. Reference lists each top-level entry in the order of `ENTRY_ORDER`, a new one at the end, as a group of its page, its modules and its sub-entries.

## The API reference

[`src/lib/api.ts`](src/lib/api.ts) reads the package's API from its source, with [oxc](https://oxc.rs) as [Rolldown](https://rolldown.rs) ships it, so the site needs no TypeScript compiler of its own:

- **What an entry exports** is what its public file says, the `source` of its subpath in the package's `exports`. A namespace (`export * as Rng from "./rng"`) is a module with a page of its own. Every other export, such as `Game.Event` or `Content`, is the entry's own, on the entry's page. A sub-entry leaves out what it re-exports from the entry above it, and says it has those too: `arcadekit/game/browser` lists `Game.Engine` and what draws, not `Game.Event` again.
- **An export's signature** is its declaration as oxc's isolated declarations write it, as `tsc --declaration` does for a package checked with `isolatedDeclarations`, as this one is. A `const` that is another file's declaration under a new name (`const Event: typeof makeEvent`) shows that declaration's signature.
- **Its text** is its doc comment, as [the doc-comments skill](../.agents/skills/doc-comments/SKILL.md) has it written: a summary, "When to use", "Details", examples, then `@category` and `@since`. A page lists the exports by category, in the order of the skill's list, and by name in each.

So a doc comment is written once, for an editor's hover and for the site, and its examples are typechecked with the rest by the smoke test. A README's table of modules links each to its source file, which on the site is the module's page.

## Its look

The site is styled after [polycombo.io](https://polycombo.io): one dark theme, square panels on hairlines, titles in [Barlow Condensed](https://fonts.google.com/specimen/Barlow+Condensed) and in capitals, labels in [IBM Plex Mono](https://fonts.google.com/specimen/IBM+Plex+Mono), text in [Inter](https://rsms.me/inter/), and an acid lime accent, with a ramp from lime to pink for what is numbered. The faces are self-hosted from their `@fontsource` packages.

- [`src/styles/custom.css`](src/styles/custom.css) holds the palette, as `--ak-*` variables that Starlight's own (`--sl-*`) are made from, and every rule over Starlight's. Starlight's styles are in CSS layers, so these, in none, win over them.
- [`src/components/`](src/components) replaces five of Starlight's components: the header's wordmark (`site-title.astro`), the landing page's hero (`hero.astro`, with the line over its title from the page's `eyebrow`), a page's title (`page-title.astro`: a reference page's keeps its case), and the theme's two (`theme-provider.astro`, `theme-select.astro`: one theme, so no picker). The landing page's numbers are `kit-stats.astro`, counted from the reference's pages.
- Code is drawn with the `vesper` theme on the page's panels (`expressiveCode` in [`astro.config.ts`](astro.config.ts)).

## How it reads the repository

Starlight serves the entries of its `docs` collection, which its own loader reads from `src/content/docs/`. There the site has its landing page alone. [`src/lib/loader.ts`](src/lib/loader.ts) adds each page `pages.ts` finds as an entry of the same collection, read where it is ([`src/content.config.ts`](src/content.config.ts)):

- Starlight writes a page's title from its frontmatter, and the files have none, since GitHub would show it. The entry's title is the file's first line, its `# ` heading, and its content is the rest of the file, so the page has one title. A reference page with no README is titled with its import path or its module's name.
- Its description is the file's first paragraph, which the page's `<meta>` tags give a shared link.
- Its edit link goes to the file on GitHub: for a module's page, its source file, whose doc comments are its text.

The loader renders each file with the site's Markdown processor, [Sätteri](https://satteri.bruits.org), Astro's own, with the plugins in `src/lib/` that [What it adds to a page](#what-it-adds-to-a-page) lists. The landing page is MDX, and imports the package's README as a component: the same processor renders both. Starlight's own transforms, such as a heading's anchor link, apply only to the folders its `markdown.processedDirs` names: here the repository's root.

## Links

The pages are also read on GitHub, and the READMEs on npm, so their links stay written for those: a relative link to another file of the repository, or a full GitHub URL for a file the npm package doesn't have, such as the glossary and every file under `docs/`. So a page under `docs/` links to a README or another page by its relative path, and a README links to a guide by its GitHub URL. [`src/lib/links.ts`](src/lib/links.ts) rewrites them as a page is rendered:

- a link to a file that is a page goes to that page;
- a link to any other file or folder of the repository goes to it on GitHub.

`pnpm build` fails on a dead link, so CI does too ([`src/lib/dead-links.ts`](src/lib/dead-links.ts)). It lists every one, of two kinds:

- A link a page's file writes to the repository, in either form: a relative link, and a full URL to `main` on GitHub. It must name a file or folder that exists. A dead link on the landing page may be written in the package's README, which it includes: the message names the file.
- A link of the built site to one of its own pages, from a page once rewritten, from the landing page or the sidebar. Its page must exist, and its fragment, such as `#commands`, must be a heading or an anchor on that page. GitHub gives a heading the same anchor, so a fragment that works here works there too, except a glossary term's: a term is a heading only here.

Two kinds of link are not checked:

- A link written as HTML, `<a href="...">`. It is not rewritten either, so a relative one is broken on the site. Write links as markdown.
- A link to another site.

A bare issue number in a page's text, such as `#25`, becomes a link to that issue on GitHub. GitHub doesn't link one in a file, so the pages keep writing them plain.

## What it adds to a page

The files are written for GitHub, so the site adds a little as it renders them, and changes no file:

- **The landing page.** It includes the package's README after its title and first paragraph, which its hero replaces ([`src/lib/landing.ts`](src/lib/landing.ts)). The build fails if the README no longer starts with a `# ` heading and a paragraph. The hero's "Get started" button goes to the README's "Install" heading, which the link check holds to.
- **The glossary.** `CONTEXT.md` is a list of paragraphs that each start with a term in bold. [`src/lib/glossary.ts`](src/lib/glossary.ts) renders the term as a heading above its definition, so each term has an address (`/glossary#lockstep`), a line in the page's table of contents and a search result of its own.
- **Search.** Starlight's search is [Pagefind](https://pagefind.app), which indexes the built site. The glossary's prose counts for half in a search (`data-pagefind-weight`, also in `glossary.ts`): a search for an export should find how to use it first. A term's heading keeps its weight, so it still comes first for the term.
- **Tables on a phone.** [`src/lib/tables.ts`](src/lib/tables.ts) lets a path in a table's cell wrap after a slash, and [`src/styles/custom.css`](src/styles/custom.css) tightens the cells, so a table fits the page.

## Which version it describes

The site is built from the repository as it is, so its pages follow `main`. Between releases they can describe an export, or a whole entry, that the package on npm doesn't have yet. The header says so: it shows the package's version alone, such as "v0.7.0", linked to the changelog, only when no changeset for `arcadekit` waits in `.changeset/`. When one does, it shows "v0.7.0 + unreleased", linked to the waiting changesets ([`src/lib/version.ts`](src/lib/version.ts), and the header's [`src/components/social-icons.astro`](src/components/social-icons.astro), which replaces Starlight's `SocialIcons`).

The other choice is a site that describes only what is released: deploy it when a release is published, not after each push to `main`. Then a fix to a page waits for the next release too. The workflow below deploys from `main`.

## Images

`public/favicon.svg` is the site's mark, and its logo. `pnpm --filter @arcadekit/website images` draws `apple-touch-icon.png` and `og.png` (the card a shared link shows, in the site's look and faces) from it, in Playwright's Chromium. Both are committed: run it again after changing the mark or the look.

## Deploying

The site is static files on Cloudflare, declared with [Alchemy](https://alchemy.run) in [`alchemy.run.ts`](alchemy.run.ts): a Worker with no script, whose assets are the build. A page is a folder's `index.html`, served at its address with no slash at the end, which is what each page's canonical link names. The `prod` stage has the custom domain `arcadekit.dev`. Every other stage is served at its `workers.dev` URL.

Set two variables, as for [the survivors demo](../examples/survivor-demo/README.md#deploying):

- `CLOUDFLARE_ACCOUNT_ID`: the account to deploy into. For the `prod` stage it must hold the `arcadekit.dev` zone.
- `CLOUDFLARE_API_TOKEN`: an API token that can do the following.
  - On the account: edit Workers scripts, read the account's settings, and edit the Secrets Store. Alchemy keeps its state in a state-store Worker in the account, and that Worker's token and key in the account's Secrets Store.
  - On the `arcadekit.dev` zone, for the `prod` stage: read the zone, and edit its DNS and its Workers routes.

[GRIMBONK](https://grimbonk.arcadekit.dev) deploys the same kind of stack to the same account and zone, at `grimbonk.arcadekit.dev`. So the token and account id that deploy it should work here unchanged. The list above is read from Alchemy's code.

Before the first `prod` deploy, the zone must have no A, AAAA or CNAME record at its apex, `arcadekit.dev` itself. A registrar's parking record is one. Alchemy attaches the hostname to the Worker as a Cloudflare custom domain, which makes the DNS record and the certificate itself, and it doesn't ask Cloudflare to replace a record that is already there.

Then, from this folder:

```bash
pnpm run plan --stage prod     # what would change
pnpm run deploy --stage prod   # build the site and upload it
pnpm exec alchemy dev          # build it and serve it from a local Worker, as Cloudflare would
```

`alchemy dev` needs no Cloudflare account. It prints its URL (`http://localhost:1337` unless that port is taken).

On `prod` the Worker also keeps its `workers.dev` URL, as GRIMBONK's does, and `www.arcadekit.dev` is not set up. Every page's canonical link names `arcadekit.dev`. `workersDev: false` and `domain: { name, redirects }` in `alchemy.run.ts` would change both.

### From CI

[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) deploys the `prod` stage after CI passes on `main`, and can be run by hand. It needs:

- the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` described above (or the same two on a `production` environment). They are GRIMBONK's two, added to this repository;
- the `arcadekit.dev` zone in that account, with its apex free.
