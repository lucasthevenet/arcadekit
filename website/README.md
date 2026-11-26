# Docs site

The arcadekit docs, [arcadekit.dev](https://arcadekit.dev): an [Astro](https://astro.build) site with the [Starlight](https://starlight.astro.build) theme, whose own pages, the walkthrough, the concepts and the guides, are under [`src/content/docs/`](src/content/docs). The reference is made from the code, as [Effect's](https://effect.website/docs/v4/api) is: an index of the packages and a page for each, from their `package.json`, and a page for each module, from its doc comments. No text is copied, so there is one to keep right.

The docs are laid out as [Effect's](https://effect.website/docs) and [Alchemy's](https://alchemy.run) are, in three topics, each with a sidebar of its own ([starlight-sidebar-topics](https://starlight-sidebar-topics.netlify.app)):

- **Learn**: the walkthrough, the concepts, and the examples.
- **Guides**: a guide for each task, and testing.
- **Reference**: the index of the packages, then for each package its page, which lists its modules, and a page for each module.

| Address | File |
| --- | --- |
| `/` | [`src/content/docs/index.mdx`](src/content/docs/index.mdx), the landing page, whose text is the site's own |
| `/<path>`, such as `/making-a-game`, `/concepts/determinism` and `/guides/input` | `src/content/docs/<path>.md`: the walkthrough, the concepts and the guides |
| `/reference` | the index of the packages, under their category, each with how many modules it has and its description ([`src/lib/reference.ts`](src/lib/reference.ts)) |
| `/reference/<package>`, such as `/reference/arcadekit` and `/reference/three` | `packages/<package>/package.json`: its description, npm, its source, and its modules |
| `/reference/<package>/<Module>`, such as `/reference/arcadekit/Sound` | the module's doc comments, from `packages/<package>/dist/<Module>.d.ts` ([The reference of a module](#the-reference-of-a-module)) |

```bash
pnpm dev:docs     # from the repo root: Astro's dev server, which reloads a page as its file changes
pnpm build:docs   # build the site to website/dist; `pnpm build` runs it too
pnpm --filter @arcadekit/website snippets   # compile the code of the site's pages, and run their tests
pnpm --filter @arcadekit/website preview    # serve the built site
```

## A new page

A markdown file under [`src/content/docs/`](src/content/docs) is a page as soon as it exists, at its path there. It is a Starlight page, with a frontmatter that gives its `title` and its `description`, the line under a shared link. Its body starts after the frontmatter, with no `# ` heading: Starlight writes the title.

A new package under `packages/` that exports a module is in the reference as soon as it exists: [`src/lib/pages.ts`](src/lib/pages.ts) finds it, and `PACKAGE_CATEGORIES` in [`src/lib/reference.ts`](src/lib/reference.ts) says which heading of the index it is under, Other if none. The pages are found when the site starts, so restart `pnpm dev:docs` after adding one. No markdown of the repository outside `src/content/docs/` is a page, the packages' READMEs included: a page links to such a file on GitHub, by its relative path.

[`src/lib/sidebar.ts`](src/lib/sidebar.ts) places each page in its topic. Its `OUTLINE` names the pages in order, in groups: a page it doesn't name goes at the end of its folder's group, so a new concept is listed at the end of Concepts, a new guide under Guides' "More" and a new package under Packages, until the outline places it. A page the outline names that doesn't exist fails the build.

## The code on a page

Every `ts` block of a page under `src/content/docs/` is compiled against the packages as they are in this checkout, by [`scripts/check-snippets.mjs`](scripts/check-snippets.mjs), which `pnpm typecheck` runs:

- A block is a program of its own: it imports what it uses.
- A block with a title, ` ```ts title="rules.ts" `, is that file of its page, and Starlight shows the title over it. Another block of the page can import it by its whole name, `"./rules.ts"`, as the repository's own resolution, `NodeNext`, asks, and a later block with the same title adds to the end of it. So a walkthrough can build a game a file at a time.
- A file whose title ends in `.test.ts` is run with Vitest: a page that shows a test shows one that passes.
- A block fenced ` ```ts sketch ` is a sketch, with `/* … */` where a game's own code goes. It is highlighted as TypeScript and nothing compiles it.

An error is reported at the page and line it is on. The landing page's blocks are not compiled: they show parts of a game, not whole ones.

## The reference of a module

Each module a package exports, every entry of its `package.json` `exports` but the package's own, has a page made from its doc comments, as [Effect's API pages](https://effect.website/docs/v4/api/effect) are made from Effect's ([`src/lib/api.ts`](src/lib/api.ts)):

- It is read from the package's built declarations, `dist/<Module>.d.ts`, so every export's signature is written out, inferred or not. `pnpm dev:docs`, `pnpm build:docs` and the site's typecheck build the packages first. A change to a doc comment shows in `pnpm dev:docs` after a restart.
- The page starts with the source file's first doc comment, then how to import the module, then every export, under a heading for the `@category` its doc comment gives, in the order of the source. The headings come in the order of `CATEGORIES` in [`src/lib/api.ts`](src/lib/api.ts); use one of those, or add it there. An export with no `@category` goes under its kind (values, classes, interfaces, types, namespaces), last.
- Each export has its doc comment, its signature (all of them, for an overloaded function) and a link to the line of the source that writes it, which the declarations' source map gives.
- A doc comment is written for an editor's tooltip, with an example as lines indented under a blank line: the page shows each such run as a `ts` block. `@param` lines are a list. An export whose comment says `@internal` is left off.

An export with no doc comment is listed with its signature alone, so give each export a comment.

## Its look

The site is styled after [polycombo.io](https://polycombo.io): one dark theme, square panels on hairlines, titles in [Barlow Condensed](https://fonts.google.com/specimen/Barlow+Condensed) and in capitals, labels in [IBM Plex Mono](https://fonts.google.com/specimen/IBM+Plex+Mono), text in [Inter](https://rsms.me/inter/), and an acid lime accent, with a ramp from lime to pink for what is numbered. The faces are self-hosted from their `@fontsource` packages.

- [`src/styles/custom.css`](src/styles/custom.css) holds the palette, as `--ak-*` variables that Starlight's own (`--sl-*`) are made from, and every rule over Starlight's. Starlight's styles are in CSS layers, so these, in none, win over them.
- [`src/components/`](src/components) replaces five of Starlight's components: the header's mark and name (`site-title.astro`: the D-pad in lime, then "arcadekit" in the text face, as Foldkit and Effect set theirs), the landing page's hero (`hero.astro`, with the line over its title from the page's `eyebrow`), a page's title (`page-title.astro`: a reference page's keeps its case), and the theme's two (`theme-provider.astro`, `theme-select.astro`: one theme, so no picker). The landing page's numbers are `kit-stats.astro`: the package's version and entries, the packages and the guides.
- The landing page is laid out as [foldkit.dev](https://foldkit.dev) is: a section for each thing the kit is, each a line in the monospace face (`<p class="eyebrow">`) over its title, then who it is and isn't a fit for. Its card grids are three to a row, or one on a narrow screen.
- Code is drawn with the `vesper` theme on the page's panels (`expressiveCode` in [`astro.config.ts`](astro.config.ts)).

## How it reads the repository

Starlight serves the entries of its `docs` collection, which its own loader reads from `src/content/docs/`: the site's own pages. [`src/lib/loader.ts`](src/lib/loader.ts) adds the reference as entries of the same collection ([`src/content.config.ts`](src/content.config.ts)): its index and each package's page, made from the packages' manifests, and each module's page, made from its doc comments. No markdown of the repository outside `src/content/docs/` is a page: a package's README is what GitHub and npm show, a short description and links to the site.

The loader renders each page it makes with the site's Markdown processor, [Sätteri](https://satteri.bruits.org), Astro's own, with the plugins in `src/lib/` that [What it adds to a page](#what-it-adds-to-a-page) lists. Starlight's own transforms, such as a heading's anchor link, apply only to the folders its `markdown.processedDirs` names: here the repository's root.

## Links

A page links to another by its relative path (`../guides/input.md`), to the reference by its address on the site (`/reference/arcadekit/Sound`), and to any other file of the repository by its relative path, as it would on GitHub. [`src/lib/links.ts`](src/lib/links.ts) rewrites them as a page is rendered:

- a link to a file that is a page goes to that page;
- a link to any other file or folder of the repository goes to it on GitHub.

`pnpm build` fails on a dead link, so CI does too ([`src/lib/dead-links.ts`](src/lib/dead-links.ts)). It lists every one, of two kinds:

- A link a page's file writes to the repository, in either form: a relative link, and a full URL to the site's branch on GitHub. It must name a file or folder that exists.
- A link of the built site to one of its own pages, from a page once rewritten, from the landing page or the sidebar. Its page must exist, and its fragment, such as `#commands`, must be a heading or an anchor on that page. GitHub gives a heading the same anchor, so a fragment that works here works there too.

Two kinds of link are not checked:

- A link written as HTML, `<a href="...">`. It is not rewritten either, so a relative one is broken on the site. Write links as markdown.
- A link to another site.

A bare issue number in a page's text, such as `#25`, becomes a link to that issue on GitHub. GitHub doesn't link one in a file, so the pages keep writing them plain.

## What it adds to a page

The files are written for GitHub, so the site adds a little as it renders them, and changes no file:

- **Search.** Starlight's search is [Pagefind](https://pagefind.app), which indexes the built site.
- **Tables on a phone.** [`src/lib/tables.ts`](src/lib/tables.ts) lets a path in a table's cell wrap after a slash, and [`src/styles/custom.css`](src/styles/custom.css) tightens the cells, so a table fits the page.

## Which version it describes

The site is built from the repository as it is, so its pages follow the branch it is built from. Its links to GitHub name that branch, `main` (`BRANCH` in [`src/lib/site.ts`](src/lib/site.ts)). Between releases they can describe an export, or a whole entry, that the package on npm doesn't have yet. The header says so: it shows the package's version alone, such as "v0.7.0", linked to the changelog, only when no changeset for `arcadekit` waits in `.changeset/`. When one does, it shows "v0.7.0 + unreleased", linked to the waiting changesets ([`src/lib/version.ts`](src/lib/version.ts), and the header's [`src/components/social-icons.astro`](src/components/social-icons.astro), which replaces Starlight's `SocialIcons`).

The other choice is a site that describes only what is released: deploy it when a release is published, not after each push to `main`. Then a fix to a page waits for the next release too. The workflow below deploys from `main`.

## Images

The site's mark is a D-pad, an arrow cut in each arm, and `public/favicon.svg` is the one file that holds its shape. As the favicon it is near-black in a light browser tab and lime in a dark one. The header draws the same shape inline, in lime (`src/components/site-title.astro`), and `pnpm --filter @arcadekit/website images` draws `apple-touch-icon.png` (the mark in lime on the page's near-black) and `og.png` (the card a shared link shows, in the site's look and faces) from it, in Playwright's Chromium. Both PNGs are committed: run it again after changing the mark or the look.

## Deploying

The site is static files on Cloudflare, declared with [Alchemy](https://alchemy.run) in [`alchemy.run.ts`](alchemy.run.ts): a Worker with no script, whose assets are the build. A page is a folder's `index.html`, served at its address with no slash at the end, which is what each page's canonical link names. The `prod` stage has the custom domain `arcadekit.dev`. Every other stage is served at its `workers.dev` URL.

Set two variables:

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
