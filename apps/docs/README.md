# Docs site

The arcadekit docs, [arcadekit.dev](https://arcadekit.dev): a [VitePress](https://vitepress.dev) site whose pages are the repository's own markdown, read where it is. No README is copied, so there is one text to keep right.

| Address | File |
| --- | --- |
| `/` | [`index.md`](index.md), which includes [the package's README](../../packages/arcadekit/README.md) after its title and first paragraph |
| `/<entry>`, such as `/core` and `/net/worker` | `packages/arcadekit/src/<entry>/README.md` |
| `/glossary` | [`CONTEXT.md`](../../CONTEXT.md), with each term as a heading |

```bash
pnpm dev:docs     # from the repo root: VitePress's dev server, which reloads a page as its file changes
pnpm build:docs   # build the site to apps/docs/dist; `pnpm build` runs it too
pnpm --filter @arcadekit/docs preview   # serve the built site
```

## A new entry's README

It is a page as soon as it exists: [`.vitepress/pages.ts`](.vitepress/pages.ts) finds every `README.md` under `packages/arcadekit/src/`, and serves `src/net/testing/README.md` at `/net/testing`. The pages are found when the site starts, so restart `pnpm dev:docs` after adding one.

Three things are still yours to do:

- Start it with its import path as the heading, `# arcadekit/net/testing`, then a paragraph. The sidebar lists the page by that heading, and the paragraph is its description under a shared link. The site builds without them, but `pnpm test` fails ([`.vitepress/pages.test.ts`](.vitepress/pages.test.ts)).
- Add its folder to `ENTRIES` in [`scripts/smoke-test.mjs`](../../scripts/smoke-test.mjs). The smoke test typechecks the `ts` examples of the READMEs in that list and of no other, so without the line the site shows examples that nothing checks.
- Keep `<T>` and `{{ }}` inside code, as the READMEs do. VitePress compiles a page as a Vue template, and the build fails on them elsewhere.

[`.vitepress/sidebar.ts`](.vitepress/sidebar.ts) lists it in its top folder's group, so `net/testing` goes beside `net`. A README in a top folder no group names goes under "More": add the folder to `GROUPS` there to place it.

An entry with no README has no page, but its address still answers: `/net/browser` goes to `/net`, the page that documents it. The build writes these redirects to `dist/_redirects` from the package's `exports`, so an entry that gets a README takes its address over. Cloudflare and `alchemy dev` apply them. VitePress's dev server and its preview do not.

## Links

The READMEs are also read on GitHub and on npm, so their links stay written for those two: a relative link to another file of the repository, or a full GitHub URL for a file the npm package doesn't have, such as the glossary. [`.vitepress/links.ts`](.vitepress/links.ts) rewrites them as a page is rendered:

- a link to a file that is a page goes to that page;
- a link to any other file or folder of the repository goes to it on GitHub.

`pnpm build` fails on a dead link, so CI does too. VitePress checks the links between pages. `links.ts` checks that every link to the repository names a file or folder that exists, in both forms: a relative link, and a full URL to `main` on GitHub. A dead link on the landing page may be written in the package's README, which it includes: the message names both files.

Three kinds of link are not checked:

- A link written as HTML, `<a href="...">`. It is not rewritten either, so a relative one is broken on the site. Write links as markdown.
- A fragment, such as `#example`. The one exception is `#install`, where the landing page's "Get started" button goes: the build fails if the package's README loses its "Install" heading.
- A link to another site.

A bare issue number in a page's text, such as `#25`, becomes a link to that issue on GitHub. GitHub doesn't link one in a file, so the READMEs and the glossary keep writing them plain.

## How it reads the repository

VitePress serves the markdown under its source folder. Here that folder is the repository's root (`srcDir` in [`.vitepress/config.ts`](.vitepress/config.ts)), `rewrites` gives each page its address, and `srcExclude` leaves out every markdown file that is not a page. Three things in the config follow from that:

- The static files are in `public/` here, not in the root's.
- A page compiles to a Vue component, and pnpm installs `vue` for VitePress only. A small plugin resolves `vue` from VitePress, wherever the page's file is.
- `vitepress` is a dev dependency of the workspace's root, as `vite` is for the demos, so that its dev server finds it from there.

VitePress 1 builds with a Vite of its own. The rest of the workspace is on Vite 8, and the two don't meet. VitePress 1 asks for Vite 5, a line that gets no more fixes: with it `pnpm audit` reported nine advisories, one of them high, all in the dev servers of Vite and esbuild, so in `pnpm dev:docs` and not in the built site. `overrides` in [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml) gives VitePress Vite 6 in its place, the oldest line that still gets fixes. That is outside the range VitePress 1 declares (`^5`). The build, the dev server, the preview and the search work on it, and the tests and CI's build run on it. If VitePress and Vite 6 ever disagree, the choice is between the override and those advisories. Remove the override with VitePress 2, which asks for a current Vite.

## What it adds to a page

The files are written for GitHub, so the site adds a little as it renders them, and changes no file:

- **The glossary.** `CONTEXT.md` is a list of paragraphs that each start with a term in bold. [`.vitepress/reference.ts`](.vitepress/reference.ts) renders the term as a heading above its definition, so each term has an address (`/glossary#lockstep`), a line in the page's outline and a search result of its own.
- **Tables on a phone.** [`.vitepress/tables.ts`](.vitepress/tables.ts) lets a path in a table's cell wrap after a slash, and [`.vitepress/theme/custom.css`](.vitepress/theme/custom.css) tightens the cells, so a table fits the page.
- **Search.** The glossary ranks below an entry's page for the same words (`boostDocument` in [`.vitepress/config.ts`](.vitepress/config.ts)): a search for an export should find how to use it first. A term's own line of the glossary still comes first for the term.

## Which version it describes

The site is built from the repository as it is, so its pages follow `main`. Between releases they can describe an export, or a whole entry, that the package on npm doesn't have yet. The top bar says so: it shows the package's version alone, such as "v0.3.0", only when no changeset for `arcadekit` waits in `.changeset/`. When one does, it shows "v0.3.0 + unreleased", and its menu links to the waiting changesets ([`.vitepress/version.ts`](.vitepress/version.ts)).

The other choice is a site that describes only what is released: deploy it when a release is published, not after each push to `main`. Then a fix to a README waits for the next release too. The workflow below deploys from `main`.

## Images

`public/favicon.svg` is the site's mark. `pnpm --filter @arcadekit/docs images` draws `apple-touch-icon.png` and `og.png` (the card a shared link shows) from it, in Playwright's Chromium. Both are committed: run it again after changing the mark.

## Deploying

The site is static files on Cloudflare, declared with [Alchemy](https://alchemy.run) in [`alchemy.run.ts`](alchemy.run.ts): a Worker with no script, whose assets are the build. The `prod` stage has the custom domain `arcadekit.dev`. Every other stage is served at its `workers.dev` URL.

Set two variables, as for [the survivors demo](../survivor-demo/README.md#deploying):

- `CLOUDFLARE_ACCOUNT_ID`: the account to deploy into. For the `prod` stage it must hold the `arcadekit.dev` zone.
- `CLOUDFLARE_API_TOKEN`: an API token that can do the following.
  - On the account: edit Workers scripts, read the account's settings, and edit the Secrets Store. Alchemy keeps its state in a state-store Worker in the account, and that Worker's token and key in the account's Secrets Store.
  - On the `arcadekit.dev` zone, for the `prod` stage: read the zone, and edit its DNS and its Workers routes.

[GRIMBONK](https://grimbonk.arcadekit.dev) deploys the same kind of stack to the same account and zone, at `grimbonk.arcadekit.dev`. So the token and account id that deploy it should work here unchanged. The list above is read from Alchemy's code: no deploy of this site has been run yet to confirm it.

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

[`deploy.workflow.example.yml`](deploy.workflow.example.yml) deploys the `prod` stage after CI passes on `main`. It does nothing where it is: GitHub runs a workflow only from `.github/workflows/`. To turn it on, do this in one commit, so that no second copy and no stale sentence is left:

1. Move it: `git mv apps/docs/deploy.workflow.example.yml .github/workflows/deploy-docs.yml`.
2. Delete the first paragraph of its header comment, which says it is an example.
3. In this section, link the workflow where it now is, and delete this list and the sentence before it.
4. Delete "The docs site's deployment" from "Not done yet" in [the root README](../../README.md#not-done-yet).
5. In `.github/workflows/ci.yml`, widen the comment above `pnpm build`: the build also builds this site, and fails on a dead link in a README.

It needs:

- the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` described above (or the same two on a `production` environment). They are GRIMBONK's two, added to this repository;
- the `arcadekit.dev` zone in that account, with its apex free.

Until the first deploy, from this workflow or by hand, arcadekit.dev serves nothing.
