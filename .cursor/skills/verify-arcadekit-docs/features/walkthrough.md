# Making a game walkthrough

Making a game is the primary Learn walkthrough: install, rules, systems, a test, and playing in a page.

## Sub-features

- `walkthrough-open` opens the page from the landing CTA and from the Learn sidebar.
- `walkthrough-sections` reaches the Install and Where to go next sections.
- `walkthrough-next` follows pagination into Entities and systems.

## How to get to it (user POV)

- Choose `Get started` on the landing page.
- Choose `Making a game` under Get started in the Learn topic sidebar.
- Open `/making-a-game` directly.

## Driving it with control-docs

Preconditions:

- Docs are healthy at the launch URL.
- Start from `/`.

- **CTA entry.** Choose Get started. Run `control-docs browser click --role link --name "Get started"`. URL ends with `/making-a-game` and the heading accessible name is `Making a game`.
- **Direct entry.** Reload the walkthrough. Run `control-docs browser goto --path /making-a-game`. Same heading.
- **Sidebar entry.** From Learn, choose Making a game. Run `control-docs browser click --role link --name "Learn"`, then `control-docs browser click --role link --name "Making a game"`. URL ends with `/making-a-game`.
- **On-this-page.** Jump to Install. Run `control-docs browser click --role link --name "Install"`. The page scrolls to the Install section (fragment `#install`).
- **Next page.** Choose the next pagination link. Run `control-docs browser click --role link --name "NextEntities and systems"`. URL ends with `/concepts/entities-and-systems`.
- **Proof.** Return to the walkthrough and capture. Run `control-docs browser goto --path /making-a-game`, `control-docs browser snapshot --aria --path artifacts/walkthrough/page.aria.txt`, and `control-docs browser screenshot --path artifacts/walkthrough/page.png`. Artifacts show heading `Making a game` and the Install section link.

## Gotchas

- Trailing slashes are rejected: use `/making-a-game`, never `/making-a-game/`.
- The Next control’s accessible name is concatenated (`NextEntities and systems`), not spaced.
- Example links under Examples point at GitHub trees, not local pages; do not treat them as in-site navigation.
