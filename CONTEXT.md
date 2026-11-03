# gamekit

Reusable primitives for browser games whose simulation is plain, deterministic TypeScript, wrapped by Effect and Foldkit for everything around it. One vocabulary is shared by every package in the workspace.

## Language

### Running a game

**GameDefinition**:
The contract a genre implements once so the runtime can run it: how to create a run's state, advance it, read its events, read input and draw it.
_Avoid_: game interface, game spec

**Run**:
One play-through from `create` to its end, fully determined by its config, its seed and the inputs it receives.
_Avoid_: session, match, level (unless the genre means a level)

**Step**:
One fixed-length advance of a run's state, given that step's input. Deterministic, and it allocates nothing.
_Avoid_: tick, update, frame (a frame is a render, and can contain zero or several steps)

**Turn**:
One player action that changes a turn-based run's state, such as a move or an undo. A turn happens inside a single step, and most steps contain no turn.
_Avoid_: step, tick, move (a move is one kind of turn)

**Event**:
A rare, meaningful fact a run reports to the outside (UI, sound, analytics), drained after steps. Never per-entity data.
_Avoid_: message (that's Foldkit's word for what an event becomes in the UI), signal

**Engine**:
The Effect-facing handle on a running game: attach it to an element, listen to its events, and start, modify, pause or stop runs.
_Avoid_: driver (the driver is the plain frame loop inside the engine), runtime

### Building blocks

**Pool**:
A fixed-capacity, struct-of-arrays collection of same-shaped entities, packed into indices [0, count). Indices are not stable across removals.
_Avoid_: entity list, ECS, store

**Tile map**:
A level's static cells (floor, wall, hole, goal…) indexed by column and row.
_Avoid_: grid (that's SpatialGrid, a proximity index of moving points), board, level map

**Genre package**:
A package that implements a GameDefinition for one kind of game (content schema, simulation, view), so several games of that genre can share it and differ only in content and screens.
_Avoid_: game package, engine (an engine runs a genre; it isn't one)

### Evaluating the kit

**Finding**:
A place where a genre had to change, work around, copy or bypass a primitive in a shared layer, or where a shared primitive's name or docs assume one genre. A primitive a genre simply doesn't use is not a finding.
_Avoid_: issue, bug, gap
