# Topic navigation

The docs are split into three topics — Learn, Guides, and Reference — each with its own sidebar. Switching topics changes both the topic highlight and the sidebar contents.

## Sub-features

- `topics-learn` opens Learn and shows Making a game in the sidebar.
- `topics-guides` opens Guides and shows Components (or another guide) in the sidebar.
- `topics-reference` opens Reference and shows the API Reference entry.

## How to get to it (user POV)

- Choose `Learn`, `Guides`, or `Reference` in the topic strip above the sidebar (navigation named `Main` on non-landing pages).

## Driving it with control-docs

Preconditions:

- Docs are healthy at the launch URL.
- Start on a page that shows the sidebar (e.g. `/making-a-game`), not only the splash landing.

- **Open a sidebar page.** Run `control-docs browser goto --path /making-a-game`. Navigation `Main` lists Learn, Guides, and Reference.
- **Guides topic.** Choose Guides. Run `control-docs browser click --role link --name "Guides"`. URL ends with `/guides/components` (Guides topic link target) and the sidebar lists `Components`.
- **Reference topic.** Choose Reference. Run `control-docs browser click --role link --name "Reference"`. URL ends with `/reference` and the sidebar lists `API Reference`.
- **Learn topic.** Choose Learn. Run `control-docs browser click --role link --name "Learn"`. URL ends with `/making-a-game` and the sidebar lists `Making a game`.
- **Proof.** On Guides, capture. Run `control-docs browser goto --path /guides/components`, `control-docs browser snapshot --aria --path artifacts/topics/guides.aria.txt`, and `control-docs browser screenshot --path artifacts/topics/guides.png`. Artifacts show topic links Learn/Guides/Reference and sidebar entry `Components`.

## Gotchas

- The splash landing (`/`) has no docs sidebar. Always switch topics from a content page.
- Topic link targets are fixed: Learn → `/making-a-game`, Guides → `/guides/components`, Reference → `/reference`.
- External example links in Learn’s Examples group leave the site; stay on in-site paths for this feature.
