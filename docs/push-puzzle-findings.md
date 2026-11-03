# Push-puzzle findings

What building a second genre, push-puzzle, showed about gamekit's shared packages (issue #4).

A **finding** (see `CONTEXT.md`) is a place where push-puzzle had to change, work around, copy or bypass a shared primitive, or where a shared primitive's name or docs assume one genre. A primitive push-puzzle simply doesn't use is not a finding.

Each finding names the primitive, what push-puzzle did, the layer a fix belongs in, and a verdict:

- **Fixed now**: a shared-layer bug that made the puzzle play wrong, or a small addition with one obvious shape both genres use.
- **Separate issue**: anything that reshapes `GameDefinition` or `GameDriver`, or whose shape needs a third genre's evidence.
- **No action**: the kit is fine; the genre was the right place.

Survivors replays identically before and after every fix: `packages/survivors/src/replay.test.ts` pins a state hash recorded before any kit change.

## Summary

| # | Primitive | Layer | Verdict |
| --- | --- | --- | --- |
| 1 | Driver resets button presses once per frame | runtime | Fixed now |
| 2 | `InputSource.endFrame` name | runtime, input | Separate issue: [#15](https://github.com/lucasthevenet/gamekit/issues/15) |
| 3 | `sample` is wall-clock only | runtime | Separate issue: [#16](https://github.com/lucasthevenet/gamekit/issues/16) |
| 4 | Pools have no stable identity | core | Separate issue: [#17](https://github.com/lucasthevenet/gamekit/issues/17) |
| 5 | No swipe input | input | Separate issue: [#18](https://github.com/lucasthevenet/gamekit/issues/18) |
| 6 | Camera helpers | render-three | Separate issue: [#19](https://github.com/lucasthevenet/gamekit/issues/19) |
| 7 | The DOM-free root entry isn't enforced | content, genre packages | Separate issue: [#20](https://github.com/lucasthevenet/gamekit/issues/20) |
| 8 | `InputBindings` requires both halves | input | Fixed now |
| 9 | "No allocation in a step" vs `InputSource.read` | runtime (docs) | Fixed now |
| 10 | `InstancedCrowd` rotates around Y only | render-three (docs) | Fixed now |
| 11 | The runtime has only a fixed-clock time model | runtime | No action |
| 12 | No snapshot or restore of state | runtime | No action |
| 13 | The view gets no previous positions | runtime | No action |
| 14 | No key repeat in the input layer | input | No action |
| 15 | `MOVE_AXES` naming | input | No action |
| 16 | Content errors name entries by index | content | No action |

Checked and not findings: `Rng`, the replay tests, restart.

## Fixed now

### 1. The driver reset button presses once per frame

- **Primitive:** `GameDriver`'s frame loop and `InputSource.endFrame`.
- **What happened:** the driver called `endFrame` once after each frame that ran steps. On a catch-up frame with four steps, all four saw the same "just pressed" key, so one press moved the player four cells. Survivors never noticed: it reads only axes.
- **Fix:** the driver calls `endFrame` after every step, and not on frames with no step, so a press is never lost either. `InputSource.endFrame` and `InputController.endFrame` docs say so. Tested in `packages/runtime/src/runtime.test.ts` with a fake input source and a driven `requestAnimationFrame`.
- **Layer:** runtime.

### 8. `InputBindings` required both axes and buttons

- **Primitive:** `InputBindings` / `InputController`.
- **What happened:** survivors passed `buttons: {}` (it has no buttons) and push-puzzle passed `axes: {}` with an explicit `never` type argument (it has no axes).
- **Fix:** both halves are optional, and `Axis` defaults to `never` like `Button` already did. Both genres dropped their empty half.
- **Layer:** input.

### 9. "No allocation in a step" and `InputSource.read`

- **Primitive:** `InputSource.read`, which runs inside the step loop.
- **What happened:** the simulation rule is "don't allocate in `step`", but `read` runs once per step too, and survivors' returns a new object each time. Push-puzzle refills one object instead. Nothing said which was expected.
- **Fix:** `read`'s docs say it runs in the step loop and may return one reused object. Survivors is left as it is: one small object per step hasn't caused a stutter.
- **Layer:** runtime (docs).

### 10. `InstancedCrowd` rotates around the vertical axis only

- **Primitive:** `InstancedCrowd.set`.
- **What happened:** the goal marker is a flat ring lying on the floor, which needs a rotation around X. `set` only takes a Y rotation. Push-puzzle rotates the ring geometry once (`RingGeometry(...).rotateX(...)`), the usual Three.js answer for a tilt every instance shares.
- **Fix:** `set`'s docs say so. A per-instance free rotation would be a new shape (quaternions) that no genre needs yet.
- **Layer:** render-three (docs).

## Separate issues

### 2. `endFrame` no longer fits its name

- **Primitive:** `InputSource.endFrame`, `InputController.endFrame`.
- **What happened:** after fix 1 the hook runs after every step. The name says frame.
- **Proposed layer:** runtime and input. Renaming is a `GameDefinition` contract change.
- **Verdict:** separate issue, [#15](https://github.com/lucasthevenet/gamekit/issues/15).

### 3. `sample` is wall-clock only

- **Primitive:** `GameDefinition.sample`.
- **What happened:** push-puzzle's HUD (moves, boxes left) changes only on a turn, but `sample` reports it every 100 ms of real time. The HUD can lag a move by up to 100 ms, and ten identical HUD events a second reach the UI while nothing happens. Push-puzzle kept the wall-clock sample unchanged and added no `turnTaken` event, so the gap stays visible.
- **Proposed layer:** runtime (a sample that fires on change, or after a step that took a turn).
- **Verdict:** separate issue, [#16](https://github.com/lucasthevenet/gamekit/issues/16). It changes `GameDefinition`.

### 4. Pools have no stable identity

- **Primitive:** `createPool` / `Pool.remove`.
- **What happened:** filling a hole removes a box, which moves another box to a new index. Undo and the view both need to name a box across turns, so each box carries an `id` field set at creation, found by a linear scan (`boxIndexById`). Undo re-adds a removed box under its old id.
- **Proposed layer:** core.
- **Verdict:** separate issue, [#17](https://github.com/lucasthevenet/gamekit/issues/17). Only one genre needs identity, and the right shape (managed ids, generational handles) isn't obvious yet.

### 5. No swipe input

- **Primitive:** `InputController`'s pointer support, which is only a drag joystick feeding an axis.
- **What happened:** push-puzzle has no touch controls. A grid game wants a swipe to count as one direction press. Touch input was out of scope, so push-puzzle is keyboard and gamepad only.
- **Proposed layer:** input (additive).
- **Verdict:** separate issue, [#18](https://github.com/lucasthevenet/gamekit/issues/18).

### 6. Camera helpers

- **Primitive:** `followTarget`, `orbitAround`, `Stage`'s camera.
- **What happened:** both helpers chase or circle a point on the ground plane, and `Stage` builds only a perspective camera. Push-puzzle needs a fixed camera that shows the whole tile map at any window shape; it works out the distance from the field of view and aspect ratio itself (`frameCamera` in `packages/push-puzzle/src/browser/view.ts`). An orthographic camera would suit a flat board better, but `Stage` can't make one.
- **Proposed layer:** render-three (a `fitCamera` helper, an orthographic option).
- **Verdict:** separate issue, [#19](https://github.com/lucasthevenet/gamekit/issues/19). A side-view genre would want the same, so its evidence should pick the shape.

### 7. The DOM-free root entry isn't enforced

- **Primitive:** the genre-package boundary ("root entry has no DOM") and `@gamekit/content`'s entry.
- **What happened:** survivors' tsconfig includes DOM types for the whole package, so its rule is a convention only. Push-puzzle added `tsconfig.sim.json`, which checks the simulation files with no DOM types, as `core` does. It can't include `content.ts`: `@gamekit/content` also exports `fetchJsonSource`, which needs `fetch`.
- **Proposed layer:** content (move `fetchJsonSource` to a browser entry), then each genre package.
- **Verdict:** separate issue, [#20](https://github.com/lucasthevenet/gamekit/issues/20). Moving an export breaks the apps' imports.

## No action

### 11. The runtime has only a fixed-clock time model

- **Primitive:** `GameDriver` / `FixedStepClock`, `GameView.render`'s `alpha`.
- **What happened:** push-puzzle runs 60 steps a second, almost all of which take no turn, and ignores `dt`. A turn is a move or an undo; a step holds at most one. Hold-to-repeat counts steps (a move on the press, then after 12 steps, then every 6), which made replays exact for free. `alpha` (interpolation between steps) is meaningless for a game that jumps a cell per turn; the view tweens in real time instead.
- **Proposed layer:** runtime.
- **Verdict:** no action. The fixed clock fit a turn-based game better than expected: the cost is a no-op `step` call per tick, and step-counted timing is what keeps repeat deterministic. The two real frictions are covered by finding 3 (`sample`) and finding 13 (the view).

### 12. No snapshot or restore of state

- **Primitive:** the runtime's `State` is opaque; there is no snapshot or restore.
- **What happened:** undo is a history of per-turn records in preallocated typed arrays (player cell, pushed box id and cell, whether a hole was filled), about 2048 deep, oldest dropped first. Restart is `start` again with the same config. A throwaway solver used to check the demo levels had to replay each state from the start.
- **Proposed layer:** genre package (undo), nowhere (restart).
- **Verdict:** no action. Turn records are smaller and exact, and they keep the step allocation-free; a snapshot per turn would allocate or need a pool of snapshots. Runtime snapshots would help tooling (solvers, rewind), not this game.

### 13. The view gets no previous positions

- **Primitive:** `GameView.render(state, time, alpha)`.
- **What happened:** the simulation moves a box to its new cell in one step. The view keeps, per box id and for the player, the cell it last saw and where it was drawn, and slides from there over 90 ms of real time. A box that fills a hole vanishes in the same step, so there's nothing to animate it falling in.
- **Proposed layer:** genre package.
- **Verdict:** no action. The tracking is about 40 lines, entirely genre-specific, and depends on finding 4's ids. Revisit if a third genre needs "what changed this step" for its view.

### 14. No key repeat in the input layer

- **Primitive:** `InputController` (it ignores the OS's key-repeat events).
- **What happened:** hold-to-repeat lives in the simulation, timed in steps. The input source remembers the most recently pressed direction, so pressing a second direction while holding the first takes over.
- **Proposed layer:** genre package.
- **Verdict:** no action. Repeat in the input layer would run on wall-clock time and break replays; the simulation is the right place.

### 15. `MOVE_AXES` naming

- **Primitive:** the `MOVE_AXES` preset (`moveX`, `moveY`; W is negative Y).
- **What happened:** push-puzzle needs four direction buttons, not analog axes, so it doesn't use the preset; it binds the same keys plus the d-pad as buttons. Survivors reads `moveY` as its `moveZ`, which the preset's docs don't mention.
- **Proposed layer:** input.
- **Verdict:** no action. Not using a preset isn't a finding; a direction-buttons preset can wait for a second grid game.

### 16. Content errors name entries by index

- **Primitive:** `loadContent`'s decoding errors.
- **What happened:** a schema error points at `levels[2].rows[1]`, not at the level's id. Push-puzzle checks level characters with a filter on the whole level, not on each row string, so the message can say `level "broken" row 2 has unknown character "x"`. Its `validate` names levels the same way.
- **Proposed layer:** content (docs at most).
- **Verdict:** no action. The schema already allows it; survivors' content is small enough that indices are fine.

## Checked, not findings

- **`Rng`.** Push-puzzle has no randomness. `create` accepts the seed and ignores it. A primitive a genre doesn't use isn't a finding.
- **The replay tests.** Survivors' hashes its pools' typed arrays; push-puzzle's compares the board as level text and the move count. Both "run a script twice, compare", but how to capture state is genre-specific, so they aren't near-identical. No shared replay helper.
- **Restart.** `GameEngine.start` with the same config resets the clock and state cleanly. Nothing to change.
