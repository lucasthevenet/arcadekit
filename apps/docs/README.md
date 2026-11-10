# Docs site

The arcadekit docs, [arcadekit.dev](https://arcadekit.dev): a [VitePress](https://vitepress.dev) site whose pages are the repository's own markdown, read where it is. No README is copied, so there is one text to keep right.

| Address | File |
| --- | --- |
| `/` | [`index.md`](index.md), which includes [the package's README](../../packages/arcadekit/README.md) after its title and first paragraph |
| `/<entry>`, such as `/core` and `/net/worker` | `packages/arcadekit/src/<entry>/README.md` |
| `/glossary` | [`CONTEXT.md`](../../CONTEXT.md) |
| `/adr` | [`adr.md`](adr.md), which lists the decisions |
| `/adr/<name>` | `docs/adr/<name>.md` |

```bash
pnpm dev:docs     # from the repo root: VitePress's dev server, which reloads a page as its file changes
pnpm build:docs   # build the site to apps/docs/dist; `pnpm build` runs it too
pnpm --filter @arcadekit/docs preview   # serve the built site
```

## A new entry's README

It is a page as soon as it exists: [`.vitepress/pages.ts`](.vitepress/pages.ts) finds every `README.md` under `packages/arcadekit/src/`, and serves `src/net/testing/README.md` at `/net/testing`. Its first heading is its title in the sidebar, and its first paragraph is its description. The pages are found when the site starts, so restart `pnpm dev:docs` after adding one.

[`.vitepress/sidebar.ts`](.vitepress/sidebar.ts) lists it in its top folder's group, so `net/testing` goes beside `net`. A README in a top folder no group names goes under "More": add the folder to `GROUPS` there to place it.

VitePress compiles a page as a Vue template. Keep `<T>` and `{{ }}` inside code, as the READMEs do, or the build fails.

## Links

The READMEs are also read on GitHub and on npm, so their links stay written for those two: a relative link to another file of the repository, or a full GitHub URL for a file the npm package doesn't have, such as a decision in `docs/adr/`. [`.vitepress/links.ts`](.vitepress/links.ts) rewrites them as a page is rendered:

- a link to a file that is a page goes to that page;
- a link to any other file or folder of the repository goes to it on GitHub.

`pnpm build` fails on a dead link, so CI does too. VitePress checks the links between pages, and `links.ts` checks that every relative link names a file or folder that exists. Neither checks a fragment (`#install`) or a link to another site.

## How it reads the repository

VitePress serves the markdown under its source folder. Here that folder is the repository's root (`srcDir` in [`.vitepress/config.ts`](.vitepress/config.ts)), `rewrites` gives each page its address, and `srcExclude` leaves out every markdown file that is not a page. Three things in the config follow from that:

- The static files are in `public/` here, not in the root's.
- A page compiles to a Vue component, and pnpm installs `vue` for VitePress only. A small plugin resolves `vue` from VitePress, wherever the page's file is.
- `vitepress` is a dev dependency of the workspace's root, as `vite` is for the demos, so that its dev server finds it from there.

VitePress 1 builds with its own Vite 5. The rest of the workspace is on Vite 8, and the two don't meet.

## Images

`public/favicon.svg` is the site's mark. `pnpm --filter @arcadekit/docs images` draws `apple-touch-icon.png` and `og.png` (the card a shared link shows) from it, in Playwright's Chromium. Both are committed: run it again after changing the mark.

## Deploying

The site is static files on Cloudflare, declared with [Alchemy](https://alchemy.run) in [`alchemy.run.ts`](alchemy.run.ts): a Worker with no script, whose assets are the build. The `prod` stage has the custom domain `arcadekit.dev`, whose zone must be in the Cloudflare account. Every other stage is served at its `workers.dev` URL.

Set the same two variables as [the survivors demo](../survivor-demo/README.md#deploying): `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. For the `prod` stage the token must also be allowed to attach a custom domain in the `arcadekit.dev` zone. Then, from this folder:

```bash
pnpm run plan --stage prod     # what would change
pnpm run deploy --stage prod   # build the site and upload it
pnpm exec alchemy dev          # build it and serve it from a local Worker, as Cloudflare would
```

`alchemy dev` needs no Cloudflare account. It prints its URL (`http://localhost:1337` unless that port is taken).

### From CI

[`deploy.workflow.example.yml`](deploy.workflow.example.yml) deploys the `prod` stage after CI passes on `main`. It is not active: copy it to `.github/workflows/deploy-docs.yml`. It needs:

- the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (or the same two on a `production` environment);
- the `arcadekit.dev` zone in that account. [GRIMBONK](https://grimbonk.arcadekit.dev) is in the same zone, at `grimbonk.arcadekit.dev`.

Until the first deploy, from this workflow or by hand, arcadekit.dev serves nothing.
