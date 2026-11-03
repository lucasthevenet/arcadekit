# gamekit glossary

The words the packages, docs, specs and findings use. One vocabulary for the whole workspace.

**GameDefinition**: the interface a genre implements once (`@gamekit/runtime`): how to create a run's state, advance it by one step, drain its events, read input and draw it. The runtime never looks inside the state.

**Run**: one play-through, from `start` to `stop` or the next `start`. A survivors run is one attempt to survive; a push-puzzle run is one attempt at one level. Restarting starts a new run with the same config.

**Step**: one fixed-length tick of the simulation (1/60 s by default), driven by the runtime's fixed clock. A slow frame can run several steps to catch up; an input source's `endStep` runs after each one, `endFrame` once per frame. A step must not allocate and must be deterministic: the same state and input give the same result.

**Turn**: one player action in a turn-based genre: a move or an undo in push-puzzle. A step holds at most one turn; most steps hold none. Don't use "step" for a turn or "turn" for a step.

**Event**: a rare, meaningful fact a run reports to the outside ("level solved", "leveled up"), pushed into an `EventBuffer` during a step and drained by the runtime. Never per-entity data. A **sample** is the runtime's read of the state for the UI (a HUD), also delivered as an event: every so many milliseconds of wall-clock time, or right after the game's **version** number changes (a turn-based HUD).

**Engine**: the Effect-facing API of a running game (`GameEngine`): attach to an element, listen to events, start, modify, pause, stop. Each genre declares its own engine service.

**Pool**: a fixed-capacity set of entities stored as one typed array per field (`createPool` in `@gamekit/core`). Removing swaps the last entity in, so pool indices are not stable. An **identified pool** (`createIdentifiedPool`) also gives each entity a stable id, for a genre that must name one entity across removals (undo, tweening).

**SpatialGrid**: a uniform grid in `@gamekit/core` for "which points are near here?", rebuilt every step from continuous positions. Not a tile map.

**Tile map**: a genre's grid of static cells (wall, floor, hole), stored in typed arrays and indexed by column and row (`row * cols + col`). It describes the level, not where entities are. Push-puzzle's lives in the genre package.

**Genre package**: a package that implements one kind of game on the kit (`@gamekit/survivors`, `@gamekit/push-puzzle`). Its root entry holds the content schema, the content service and the simulation, with no DOM or Three.js (checked by its `tsconfig.root.json`); its `./browser` entry holds the `GameDefinition`, the view and the engine.

**Finding**: a place where a genre had to change, work around, copy or bypass a shared primitive, or where a shared primitive's name or docs assume one genre. A primitive a genre simply doesn't use is not a finding. See `docs/push-puzzle-findings.md`.
