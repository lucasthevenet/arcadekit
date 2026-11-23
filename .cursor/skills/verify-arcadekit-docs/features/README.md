# arcadekit docs verification map

This directory is the maintained source for verifying the reader-facing behavior of the arcadekit docs site. Read the index before driving the site, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch with `control-docs launch` so the site is at `http://127.0.0.1:4321` (or the port you passed) from a built `website/dist`.
- Run `control-docs doctor` and require `"ok": true`, the expected URL, and live preview/browser pids.
- Never drive an instance that was not started by this verification run.
- Put `control-docs` on `PATH` (`.cursor/skills/verify-arcadekit-docs/bin`) or invoke it via `node .cursor/skills/verify-arcadekit-docs/bin/control-docs`.

## Driving conventions

- Start every recipe from the landing page (`control-docs browser goto --path /`) unless its preconditions say otherwise.
- Prefer ARIA roles and accessible names over CSS selectors or DOM position.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Run browser actions through `control-docs browser`.
- After a mutation of location (navigation), assert URL and heading before capturing proof.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes an ARIA snapshot and a screenshot with the brand link `arcadekit` visible.
- Record the feature ID and entry point used with every artifact under `artifacts/<feature-id>/`.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with control-docs` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Landing page](./landing.md) covers the hero, brand, and Get started CTA.
- [Making a game walkthrough](./walkthrough.md) covers opening and reading the walkthrough.
- [Topic navigation](./topics.md) covers Learn / Guides / Reference topic switching.
- [API reference](./reference.md) covers the reference index, package page, and a module page.
- [Search](./search.md) covers opening Pagefind search, matching, and opening a result.
