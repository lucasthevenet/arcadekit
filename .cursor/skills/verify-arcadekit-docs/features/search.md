# Search

Site search (Pagefind via Starlight) finds pages by title and body text, then opens a result.

## Sub-features

- `search-open` opens the search dialog from the header button.
- `search-match` returns results for a known concept query.
- `search-open-result` navigates to a matched page.
- `search-empty` shows a no-results state for nonsense input.

## How to get to it (user POV)

- Choose the `Search` button in the header.
- Press `Control+K` (or `Meta+K` on macOS) while the page is focused.

## Driving it with control-docs

Preconditions:

- Instance was started with `control-docs launch` (built preview). Search does **not** work under `astro dev`.
- Docs are healthy at the launch URL.
- Start from `/`.

- **Open search.** Choose Search. Run `control-docs browser click --role button --name "Search"`. A dialog opens with a field whose placeholder is `Search`.
- **Keyboard entry.** Close with Escape if needed (`control-docs browser press --key Escape`), then press Control+K. Run `control-docs browser press --key Control+k`. The same dialog opens.
- **Match.** Type a known concept. Run `control-docs browser fill --placeholder "Search" --value "determinism"`. Wait until results appear: `control-docs browser wait --text "results for determinism"`. A link named `Determinism` is listed.
- **Open result.** Choose Determinism. Run `control-docs browser click --role link --name "Determinism"`. URL contains `/concepts/determinism` and the heading is `Determinism`.
- **Empty state.** Reopen search and query nonsense. Run `control-docs browser click --role button --name "Search"`, `control-docs browser fill --placeholder "Search" --value "zzzxnotapage"`, and `control-docs browser wait --text "No results"`. (If the empty copy differs, assert the dialog text has no link to a docs path and report the actual copy in the proof.)
- **Proof.** Re-run a successful match and capture the dialog before clicking through: after fill+wait, `control-docs browser snapshot --aria --path artifacts/search/results.aria.txt` and `control-docs browser screenshot --path artifacts/search/results.png`. Artifacts show the query and `Determinism`.

## Gotchas

- Under `astro dev`, the dialog says search is only available in production builds. That is a failed precondition, not an empty result.
- Result titles can repeat (`Determinism` appears more than once). Clicking the first `Determinism` link is enough; then assert the URL.
- Wait for the results summary text; results are async after typing.
- Clear the dialog with Escape before unrelated navigation so it does not intercept clicks.
