# Push-puzzle findings

What building a second genre, push-puzzle, showed about gamekit's shared packages (issue #4).

The later architecture survey (#27) is in [architecture-review.md](architecture-review.md).

A **finding** (see `CONTEXT.md`) is a place where push-puzzle had to change, work around, copy or bypass a shared primitive, or where a shared primitive's name or docs assume one genre. A primitive push-puzzle simply doesn't use is not a finding.

Each finding names the primitive, what push-puzzle did, the layer a fix belongs in, and a verdict:

- **Fixed now**: a shared-layer bug that made the puzzle play wrong, or a small addition with one obvious shape both genres use.
- **Separate issue**: anything that reshapes `GameDefinition` or `GameDriver`, or whose shape needs a third genre's evidence. All six were filed, then fixed in the kit when the kit's author asked for it (issues #15 to #20); each entry below says which shape was picked and why.
- **No action**: the kit is fine; the genre was the right place.

Survivors replays identically before and after every kit change: `packages/survivors/src/replay.test.ts` pins a state hash recorded before any kit change. The replay calls the simulation directly, so it guards core and survivors' simulation; the runtime loop and input have their own tests.

## Summary

| # | Primitive | Layer | Verdict |
| --- | --- | --- | --- |
| 1 | A press reaches every step of a catch-up frame | runtime, input | Fixed: [#15](https://github.com/lucasthevenet/gamekit/issues/15) |
| 2 | `sample` is wall-clock only | runtime | Fixed: [#16](https://github.com/lucasthevenet/gamekit/issues/16) |
| 3 | Pools have no stable identity | core | Fixed: [#17](https://github.com/lucasthevenet/gamekit/issues/17) |
| 4 | No swipe input | input | Fixed: [#18](https://github.com/lucasthevenet/gamekit/issues/18) |
| 5 | Camera helpers | render-three | Fixed: [#19](https://github.com/lucasthevenet/gamekit/issues/19) |
| 6 | The DOM-free root entry isn't enforced | content, genre packages | Fixed: [#20](https://github.com/lucasthevenet/gamekit/issues/20) |
| 7 | `InputBindings` requires both halves | input | Fixed now |
| 8 | "No allocation in a step" vs `InputSource.read` | runtime (docs) | Fixed now |
| 9 | `MeshInstances` rotates around Y only | render-three (docs) | Fixed now |
| 10 | The runtime has only a fixed-clock time model | runtime | No action |
| 11 | No snapshot or restore of state | runtime | No action |
| 12 | The view gets no previous positions | runtime | No action |
| 13 | No key repeat in the input layer | input | No action |
| 14 | `MOVE_AXES` naming | input | No action |
| 15 | Content errors name entries by index | content | No action |

Checked and not findings: `Rng`, the replay tests, restart.

## Filed as separate issues, then fixed

Each of these was filed because it changes a shared contract or its shape wasn't obvious from two genres. Each fix is additive: a genre that doesn't use it is unchanged, and survivors' replay hash didn't move.

### 1. A press reaches every step of a catch-up frame

- **Primitive:** `GameDriver`'s frame loop and `InputSource.endFrame`.
- **What happened:** the driver reset "just pressed" state once per frame (`endFrame`), but a slow frame runs several catch-up steps, and every one of them saw the same press. Push-puzzle makes one turn per press, so one press moved the player up to five cells and one undo undid up to five turns. Survivors never noticed: it reads only axes.
- **What push-puzzle did first:** its input source reported each press to one `read` only, and forgot what it reported in `endFrame`.
- **Why not the obvious fix:** calling `endFrame` after every step was tried and reverted. It keeps the hook's name and type but changes when it runs, so any input source doing per-frame work in it would silently run it up to five times a frame (`InputController.endFrame` polls the gamepads).
- **Fix ([#15](https://github.com/lucasthevenet/gamekit/issues/15)):** a new optional `InputSource.endStep`, called after every step, and `InputController.consumePresses()` to call from it. `endFrame` keeps its per-frame meaning. Push-puzzle's workaround is gone; survivors needs neither. `packages/runtime/src/loop.test.ts` checks both behaviors and the call order (moved from `runtime.test.ts` by #28).
- **Layer:** runtime and input.

### 2. `sample` is wall-clock only

- **Primitive:** `GameDefinition.sample`.
- **What happened:** push-puzzle's HUD (moves, boxes left) changes only on a turn, but `sample` reported it every 100 ms of real time. The HUD could lag a move by up to 100 ms, and ten identical HUD events a second reached the UI while nothing happened.
- **Fix ([#16](https://github.com/lucasthevenet/gamekit/issues/16)):** `sample.everyMs` is optional, and `sample.version` is new: a cheap number the game bumps when what `read` reports may have changed. The driver emits a sample right after any frame or `modify` in which it changed. Push-puzzle's version is a turn counter (`Puzzle.turns`); survivors keeps its 100 ms timer. A game can use both.
- **Layer:** runtime.

### 3. Pools have no stable identity

- **Primitive:** `createPool` / `Pool.remove`.
- **What happened:** filling a hole removes a box, which moves another box to a new index. Undo and the view both need to name a box across turns, so each box carried an `id` field set at creation, found by a linear scan.
- **Fix ([#17](https://github.com/lucasthevenet/gamekit/issues/17)):** `createIdentifiedPool` in core: a pool that also keeps a stable id per entity (`idOf`, `indexOf`), and can bring a removed entity back under its old id (`addWithId`), all O(1) and allocation-free. Ids are reused after removal; generational handles were left out, since neither genre needs them. `createPool` is unchanged, so survivors is untouched. Push-puzzle's id field and scan are gone.
- **Layer:** core.

### 4. No swipe input

- **Primitive:** `InputController`'s pointer support, which was only a drag joystick feeding an axis.
- **What happened:** push-puzzle had no touch controls. A grid game wants a swipe to count as one direction press.
- **Fix ([#18](https://github.com/lucasthevenet/gamekit/issues/18)):** `ButtonBinding.swipe` makes a short, fast stroke in that direction count as a press (never as held), with `swipeDistance` and `swipeMs` options. Push-puzzle binds its four directions to swipes, so it plays on a phone. `InputController` has its first tests (`packages/input/src/input-controller.test.ts`).
- **Layer:** input.

### 5. Camera helpers

- **Primitive:** `followTarget`, `orbitAround`, `Stage`'s camera.
- **What happened:** both helpers chase or circle a point on the ground plane, and `Stage` built only a perspective camera. Push-puzzle worked out a fit-the-map distance itself (`frameCamera`).
- **Fix ([#19](https://github.com/lucasthevenet/gamekit/issues/19)):** `fitCamera(camera, bounds, { margin, tilt })` frames a ground-plane rectangle with either camera kind, and `StageOptions.camera: "orthographic"` builds an orthographic camera that keeps its view height on resize (`Stage` is typed by the kind). Push-puzzle now uses an orthographic stage and `fitCamera`. A side-view genre would want a version for the vertical plane; that waits for one.
- **Layer:** render-three.

### 6. The DOM-free root entry isn't enforced

- **Primitive:** the genre-package boundary ("root entry has no DOM") and `@gamekit/content`'s entry.
- **What happened:** survivors' tsconfig included DOM types for the whole package, so its rule was a convention only. Push-puzzle checked only some files without DOM, because `@gamekit/content` also exported `fetchJsonSource`, which needs `fetch`.
- **Fix ([#20](https://github.com/lucasthevenet/gamekit/issues/20)):** `fetchJsonSource` moved to `@gamekit/content/browser`, and the apps import it from there. `content`, `survivors` and `push-puzzle` each have a `tsconfig.root.json` that checks their root entry with no DOM types, run by `pnpm typecheck`.
- **Layer:** content, then each genre package.

## Fixed now

### 7. `InputBindings` required both axes and buttons

- **Primitive:** `InputBindings` / `InputController`.
- **What happened:** survivors passed `buttons: {}` (it has no buttons) and push-puzzle passed `axes: {}` with an explicit `never` type argument (it has no axes).
- **Fix:** both halves are optional, and `Axis` defaults to `never` like `Button` already did. Both genres dropped their empty half.
- **Layer:** input.

### 8. "No allocation in a step" and `InputSource.read`

- **Primitive:** `InputSource.read`, which runs inside the step loop.
- **What happened:** the simulation rule is "don't allocate in `step`", but `read` runs once per step too, and survivors' returns a new object each time. Push-puzzle refills one object instead. Nothing said which was expected.
- **Fix:** `read`'s docs say it runs in the step loop and may return one reused object. Survivors is left as it is: one small object per step hasn't caused a stutter.
- **Layer:** runtime (docs).

### 9. `MeshInstances` rotates around the vertical axis only

- **Primitive:** `MeshInstances.set`. The class was named `InstancedCrowd` until [#27](https://github.com/lucasthevenet/gamekit/issues/27).
- **What happened:** the goal marker is a flat ring lying on the floor, which needs a rotation around X. `set` only takes a Y rotation. Push-puzzle rotates the ring geometry once (`RingGeometry(...).rotateX(...)`), the usual Three.js answer for a tilt every instance shares.
- **Fix:** `set`'s docs say so. A per-instance free rotation would be a new shape (quaternions) that no genre needs yet.
- **Layer:** render-three (docs).

## No action

### 10. The runtime has only a fixed-clock time model

- **Primitive:** `GameDriver` / `FixedStepClock`, `GameView.render`'s `alpha`.
- **What happened:** push-puzzle runs 60 steps a second, almost all of which take no turn, and ignores `dt`. A turn is a move or an undo; a step holds at most one. Hold-to-repeat counts steps (a move on the press, then after 12 steps, then every 6), which made replays exact for free. `alpha` (interpolation between steps) is meaningless for a game that jumps a cell per turn; the view tweens in real time instead.
- **Proposed layer:** runtime.
- **Verdict:** no action. The fixed clock fit a turn-based game better than expected: the cost is a no-op `step` call on almost every step, and step-counted timing is what keeps repeat deterministic. The two real frictions are finding 2 (`sample`, now fixed) and finding 12 (the view).

### 11. No snapshot or restore of state

- **Primitive:** the runtime's `State` is opaque; there is no snapshot or restore.
- **What happened:** undo is a history of per-turn records in preallocated typed arrays (player cell, pushed box id and cell, whether a hole was filled), about 2048 deep, oldest dropped first. Restart is `start` again with the same config. A throwaway solver used to check the demo levels had to replay each state from the start.
- **Proposed layer:** genre package (undo), nowhere (restart).
- **Verdict:** no action. Turn records are smaller and exact, and they keep the step allocation-free; a snapshot per turn would allocate or need a pool of snapshots. Runtime snapshots would help tooling (solvers, rewind), not this game.

### 12. The view gets no previous positions

- **Primitive:** `GameView.render(state, time, alpha)`.
- **What happened:** the simulation moves a box to its new cell in one step. The view keeps, per box id and for the player, the cell it last saw and where it was drawn, and slides from there over 90 ms of real time. A box that fills a hole vanishes in the same step, so there's nothing to animate it falling in.
- **Proposed layer:** genre package.
- **Verdict:** no action. The tracking is about 40 lines, entirely genre-specific, and uses the identified pool's ids from finding 3. Revisit if a third genre needs "what changed this step" for its view.

### 13. No key repeat in the input layer

- **Primitive:** `InputController` (it ignores the OS's key-repeat events).
- **What happened:** hold-to-repeat lives in the simulation, timed in steps. The input source remembers the most recently pressed direction, so pressing a second direction while holding the first takes over.
- **Proposed layer:** genre package.
- **Verdict:** no action. Repeat in the input layer would run on wall-clock time and break replays; the simulation is the right place.

### 14. `MOVE_AXES` naming

- **Primitive:** the `MOVE_AXES` preset (`moveX`, `moveY`; W is negative Y).
- **What happened:** push-puzzle needs four direction buttons, not analog axes, so it doesn't use the preset; it binds the same keys plus the d-pad as buttons. Survivors reads `moveY` as its `moveZ`. The preset's docs didn't say so; #27 documented it.
- **Proposed layer:** input.
- **Verdict:** no action. Not using a preset isn't a finding; a direction-buttons preset can wait for a second grid game.

### 15. Content errors name entries by index

- **Primitive:** `loadContent`'s decoding errors.
- **What happened:** a schema error points at `levels[2].rows[1]`, not at the level's id. Push-puzzle checks level characters with a filter on the whole level, not on each row string, so the message can say `level "broken" row 2 has unknown character "x"`. Its `validate` names levels the same way.
- **Proposed layer:** content (docs at most).
- **Verdict:** no action. The schema already allows it; survivors' content is small enough that indices are fine.

## Checked, not findings

- **`Rng`.** Push-puzzle has no randomness. `create` accepts the seed and ignores it. A primitive a genre doesn't use isn't a finding.
- **The replay tests.** Survivors' hashes its pools' typed arrays; push-puzzle's compares the board as level text and the move count. Both "run a script twice, compare", but how to capture state is genre-specific, so they aren't near-identical. No shared replay helper.
- **Restart.** `GameEngine.start` with the same config resets the clock and state cleanly. Nothing to change.
