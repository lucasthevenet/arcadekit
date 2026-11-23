---
name: verify-arcadekit-docs
description: Drive the arcadekit docs site (arcadekit.dev) in a browser the way a reader would — landing, walkthrough, topic nav, API reference, and search. Use when proving a docs or site change works, or when a task needs end-to-end evidence from the real pages.
---

# Verify arcadekit docs

Primary surface: the **docs site** under `website/` (Starlight + Astro), served as readers see it at [arcadekit.dev](https://arcadekit.dev).

Other surfaces in this repo (not driven by this skill): the published libraries (`pnpm test`), the in-page example games (`pnpm --filter arcadekit page`, `pnpm --filter @arcadekit/three page`), and the Node demos (`pnpm --filter arcadekit demo`).

Put `.cursor/skills/verify-arcadekit-docs/bin` on `PATH`, or invoke helpers as `node .cursor/skills/verify-arcadekit-docs/bin/control-docs …` from the repo root.

## Launch

Verification uses a **built preview** (not `astro dev`). Pagefind search only indexes production builds; `astro preview` is the usable surface.

```sh
# Once per machine / CI image
pnpm install
pnpm --filter @arcadekit/website exec playwright install chromium

# Start (builds packages + docs unless --skip-build and website/dist exists)
control-docs launch --port 4321
# Ready when stdout JSON has "ok": true and url http://127.0.0.1:<port>
# Preview log: .cursor/skills/verify-arcadekit-docs/.run/preview.log
```

Ready means: HTTP 200 at the URL, HTML contains `arcadekit`, Chromium CDP is up, and the open page shows the site title link. A process that only binds the port is not enough.

Teardown:

```sh
control-docs stop
```

Side-by-side instances: set `ARCADEKIT_DOCS_VERIFY_DIR` to a fresh directory and pass a free `--port` / `--cdp-port`. Default state lives in `.cursor/skills/verify-arcadekit-docs/.run/` (gitignored). Never drive a preview or browser this run did not start; `launch` refuses if its state file still names live pids.

## Doctor

```sh
control-docs doctor
```

Exit 0 only when the preview pid and browser pid are alive, the URL returns HTML with the brand string, and CDP answers. Run this first whenever anything looks off.

## Drive

All browser actions go through `control-docs browser`. Prefer roles and accessible names from the live ARIA tree.

Stable handles on this site:

| What | Handle |
| --- | --- |
| Brand / home | link role, name `arcadekit` (class `site-title`, href `/`) |
| Search | button role, name `Search` (opens a `dialog`) |
| Search field | placeholder `Search` inside the open dialog |
| Hero CTA | link role, name `Get started` → `/making-a-game` |
| Topics | links `Learn`, `Guides`, `Reference` in navigation `Main` |
| Walkthrough | path `/making-a-game`, heading includes `Making a game` |
| Reference index | path `/reference` |
| Package page | path `/reference/arcadekit` or `/reference/three` |
| Module page | path `/reference/arcadekit/<Module>` (e.g. `Sound`) |

Examples:

```sh
control-docs browser goto --path /
control-docs browser click --role link --name "Get started"
control-docs browser url
control-docs browser text --role heading --name "Making a game"
control-docs browser click --role button --name "Search"
control-docs browser fill --placeholder "Search" --value "determinism"
control-docs browser wait --text "results for determinism"
control-docs browser click --role link --name "Determinism"
```

Routes use Starlight's `trailingSlash: "never"`: `/making-a-game`, not `/making-a-game/`.

## Evidence

Proof artifacts go under `.cursor/skills/verify-arcadekit-docs/artifacts/<feature-id>/` (gitignored). That directory survives `control-docs stop`.

```sh
control-docs browser snapshot --aria --path artifacts/landing/home.aria.txt
control-docs browser screenshot --path artifacts/landing/home.png
```

Proof standards:

- Exercise the reader path (nav links, hero CTA, search results), not internal Astro APIs or editing markdown and assuming the page looks right.
- Capture the action and the resulting URL/heading/ARIA, not only a final screenshot.
- Search proof must show a result list that names the target page, then a navigation that lands on that page's heading.
- Do not treat the Astro dev toolbar buttons (`Inspect`, `Audit`, `Settings`) as product UI.
- `astro dev` is not a substitute for launch: search will say it is only available in production builds.

## Cleanup

```sh
control-docs stop
```

Stops only the preview and browser pids recorded in this run's state file. Removes the state file. Leaves `artifacts/` alone. Does not delete `website/dist`.

## Helpers

| Command | Purpose |
| --- | --- |
| `control-docs launch [--port N] [--cdp-port N] [--skip-build]` | Build (unless skipped), preview on `127.0.0.1`, open Chromium via CDP |
| `control-docs doctor` | Read-only health check |
| `control-docs stop` | Tear down this run's pids |
| `control-docs browser …` | Drive the open page |

Feature recipes live in [`features/`](features/README.md). Read the index, then the feature file for the journey you are proving.
