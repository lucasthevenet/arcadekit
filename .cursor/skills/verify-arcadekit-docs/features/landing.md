# Landing page

The landing page introduces arcadekit: brand in the header, hero headline, short pitch, and a Get started CTA into the walkthrough.

## Sub-features

- `landing-brand` shows the `arcadekit` site title linking home.
- `landing-hero` shows the hero heading and supporting sentence.
- `landing-cta` follows Get started into the walkthrough.

## How to get to it (user POV)

- Open `/` in the browser.
- Choose the `arcadekit` brand link from any page.

## Driving it with control-docs

Preconditions:

- Docs are healthy at the launch URL (`control-docs doctor`).
- Start from a cold page load of `/`.

- **Open landing.** Go to `/`. Run `control-docs browser goto --path /`. The document title contains `arcadekit` and a link named `arcadekit` is visible.
- **Confirm hero.** Read the main heading. Run `control-docs browser text --role heading --name "Effect for browser games."`. The text matches (Starlight may render it in capitals visually; the accessible name is the hero title).
- **Follow CTA.** Choose Get started. Run `control-docs browser click --role link --name "Get started"`. The URL ends with `/making-a-game`.
- **Return via brand.** Choose the brand. Run `control-docs browser click --role link --name "arcadekit"`. The URL is the site root.
- **Proof.** Capture the landing state. Run `control-docs browser goto --path /`, then `control-docs browser snapshot --aria --path artifacts/landing/home.aria.txt` and `control-docs browser screenshot --path artifacts/landing/home.png`. Both show the brand and Get started.

## Gotchas

- The hero heading’s visual CSS is uppercase; assert with the accessible name `Effect for browser games.` (trailing period included).
- `GitHub` appears both in the hero and the header. Prefer the hero CTA `Get started` for the walkthrough entry.
- Astro preview may inject toolbar buttons (`Inspect`, `Audit`, `Settings`). Ignore them.
