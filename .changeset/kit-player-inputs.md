---
"arcadekit": minor
---

The kit owns the step input of a game with several players, and how lockstep fills it. Each game used to carry its own copy of the same type and two helpers.

- `arcadekit/runtime` exports `PlayerInputs<PlayerInput>`: `players[slot]` is one player's input for the step, or null when that player has none, and `leaving` lists the slots that leave the run at this step, in ascending order. A slot is a player's place in the run's player order, host first in lockstep. A game uses it as its `GameSimulation`'s `Input`.
- `arcadekit/runtime` exports `soloInput(source)`: a `StepInput<PlayerInputs<PlayerInput>>` from one player's `StepInput<PlayerInput>`, at slot 0, with nobody leaving. `endStep` and `endFrame` reach the source.
- `arcadekit/net` exports `combinePlayerInputs(players)`: a lockstep session's `combine` for such a game. `players` is the run's player order, host first; it returns a function from a `ConfirmedStep<PlayerInput>` to `PlayerInputs<PlayerInput>`.

All three are plain code, with no Effect. `soloInput` and `combinePlayerInputs` refill one object, so a step allocates nothing.

Nothing breaks for the existing entries: these are new exports, no export changed, and it adds no arrow between entries (`net` already imports `runtime`).
