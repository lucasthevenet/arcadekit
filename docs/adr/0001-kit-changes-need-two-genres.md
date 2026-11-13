---
status: accepted
---

# Change the kit only where two genres or two apps show the need

> Amended on 2026-11-06: `GameDriver` is gone; `makeGameEngine`'s `attach` is the `requestAnimationFrame` adapter, see the note on [ADR-0010](0010-a-game-is-a-simulation-and-a-presentation.md).

> Amended by [ADR-0020](0020-a-game-is-declared.md) on 2026-11-11: `makeGameEngine` and the `runtime` entries are gone; a `Game.Engine`'s `attach` is that adapter. See the note on [ADR-0010](0010-a-game-is-a-simulation-and-a-presentation.md).

Survivors shaped the kit alone, so nobody could tell which of its primitives were general and which only looked general (#4). The kit changes only where two genres, or two apps, show the same need (#4, restated in #27). A need that only one of them shows is recorded as a finding or an issue, and its code stays in that genre or app.

## Consequences

- A genre writes its workaround first. The workaround moves into the kit once a second genre needs it. Push-puzzle's tile map stays in its genre package, and a direction-buttons input preset waits for a second grid game (finding 14).

  > Amended on 2026-11-13: grimbonk's terrain is the second: the tile map is `createTileMap` in `arcadekit/core`.

- A shared-layer bug that makes a genre play wrong is fixed right away, unless the fix changes `GameDefinition` or `GameEngine`. A contract change gets its own issue (#4, #27).
- The kit's author can pick a shape early. PR #22 did that for #15, #16, #17 and #19, whose findings had left the shape to a third genre. Each fix is additive, so a genre that doesn't use it is unchanged.
- #23 follows the rule: each demo app builds its own save first. Whether a shared save package belongs in the kit is decided once both apps have one, and that answer becomes an ADR.
- Revisit if a follow-up needs a kit change that only one genre shows. #25 is the likely case: lockstep serves survivors' co-op, and push-puzzle uses it only if it gets the versus race that #25 suggests.
