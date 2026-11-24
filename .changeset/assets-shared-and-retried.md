---
"arcadekit": minor
---

`Assets.Store` fetches a file once for every held bundle that names it, decodes an asset once for every held bundle that has it, and releases it when the last of them is let go. A fetch that got no answer, or a server's answer of 500 or more, is tried again up to three times, 200, 400 and 800 milliseconds later, so a bundle recovers without its level being entered again. `Assets.AssetFailed` has an optional `transient`, which the default loader sets for those failures, and which a loader of a game's own sets for a failure worth trying again.

Nothing breaks: `Assets.Status`, `Assets.during`, `hold` and `drop` are as they were.
