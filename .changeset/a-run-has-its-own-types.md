---
"arcadekit": patch
---

`Driver.run` given no `ready` fails with and needs only what its game or its session does. Before, a run with no `ready`, put where a wider effect was expected, took that effect's error and requirements for its own: `Driver.run(Game, { hz: 60 }) satisfies Effect.Effect<never, Lost, Menu>` was typed as failing with `Lost` and needing `Menu`, and so was a run written inline in a call that expects such an effect. `Driver.run` now has a signature for a game and one for a session with no `ready`, before the two with one.

Nothing breaks. A run with a `ready` is typed as it was.
