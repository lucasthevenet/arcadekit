# Architecture review

The survey of gamekit's architecture before the follow-ups #23 to #26, and what came of it (issue [#27](https://github.com/lucasthevenet/gamekit/issues/27)). It started from `main` at `89665dc`.

A **finding** (see `CONTEXT.md`) is a place where a genre had to change, work around, copy or bypass a shared primitive, or where a shared primitive's name or docs assume one genre. The survey looked for the same thing in the apps: a seam both demo apps wire by hand. The evidence rule is [ADR 0001](adr/0001-kit-changes-need-two-genres.md): the kit changes only where two genres, or two apps, show the need. A need only one of them shows is recorded, and its code stays where it is.

Each candidate names what it was, a verdict and where it landed:

- **Fixed now**: both genres or both apps show it, and the fix doesn't change `GameDefinition`, `GameDriver` or `GameEngine`.
- **Separate issue**: the fix changes a kit contract or a documented behavior, or waits on a follow-up's decision.
- **No action**: only one genre shows it, or there is nothing to fix. Recorded here for the follow-up it affects.

No commit changes either demo's behavior. `packages/survivors/src/replay.test.ts` is byte-identical to `89665dc`, and both genres' replay hashes didn't move.

## Summary

| # | Candidate | Verdict | Landed in |
| --- | --- | --- | --- |
| 1 | The viewport and engine seam is wired by hand in both apps | Fixed now | "Give the viewport and engine seam one home in @gamekit/foldkit" |
| 2 | Each genre's engine key and layer | No action |  |
| 3a | `InstancedCrowd`'s name | Fixed now | "Rename InstancedCrowd to MeshInstances" |
| 3b | Camera helper and `Stage` docs | Fixed now | "Say where the camera helpers and MOVE_AXES work" |
| 3c | `SpatialGrid` docs | No action |  |
| 3d | `MOVE_AXES`'s sign | Fixed now | "Say where the camera helpers and MOVE_AXES work" |
| 4 | Unused exports and dependencies | Fixed now; genre exports: separate issue | "Remove unused core math exports and app dependencies"; [#30](https://github.com/lucasthevenet/gamekit/issues/30) |
| 5 | Decisions that live only in prose | Fixed now | "Record the kit decisions the follow-ups build on as ADRs" |
| 6 | Survivors' `world.ts` is one large module | No action | Recorded for #25 |
| 7 | Glossary drift | Fixed now | "Bring the kit's docs back to the glossary"; "Rename HudSnapshot to HudSample in both genres" |
| 8 | The step loop only runs inside `requestAnimationFrame` | Separate issue | [#28](https://github.com/lucasthevenet/gamekit/issues/28) |
| 9 | Views' unwritten rules about a run | Fixed now | "Write down what views may assume about a run" |
| 10 | Event payloads typed twice, in the genre and the app | Fixed now | "Declare event payloads once, as Schemas in each genre" |
| 11 | Every caller rebuilds a genre's content recipe | Fixed now | "Give each genre one content definition its layer and tests share" |
| 12 | The content loader caches failures | Separate issue | [#29](https://github.com/lucasthevenet/gamekit/issues/29) |
| 13 | Seams both apps use have no tests | Fixed now | "Test engine attach, stop and pause, and the camera helpers"; candidate 1's commit |
| 14 | The runtime can't see a run end | No action | Recorded for #24 and #25 |

## ADRs

Candidate 5 wrote these. Each names its source, the follow-ups it constrains and what would reopen it.

- [0001](adr/0001-kit-changes-need-two-genres.md) Change the kit only where two genres or two apps show the need
- [0002](adr/0002-genre-root-entries-are-dom-free.md) A genre's root entry has no DOM or Three.js
- [0003](adr/0003-one-fixed-step-clock.md) Every genre runs on the runtime's fixed-step clock
- [0004](adr/0004-one-press-one-step.md) One press reaches one step
- [0005](adr/0005-samples-on-a-timer-or-a-version.md) A sample runs on a timer, a version, or both
- [0006](adr/0006-identified-pools-reuse-ids.md) Identified pools give stable ids and reuse them
- [0007](adr/0007-no-runtime-snapshots.md) The runtime keeps no snapshots of a run
- [0008](adr/0008-events-are-rare-facts.md) An event is a rare, meaningful fact

## Fixed now

### 1. The viewport and engine seam

- **What it was:** both apps wired the viewport element, its mount Message, a mounted flag and the engine's Subscription entry across five files, almost line for line. The rule holding it together ("the viewport must always render") lived only in comments.
- **Fix:** `@gamekit/foldkit` has `gameViewport`, which renders the viewport and reports its mount and unmount, and `engineEntry`, a Subscription entry that runs the engine while the app's Boolean is true. Each app passes its engine and its own event to Message map. `engineMessages` left the public API. `keyPresses` moved to `keys.ts` with its first test.

### 3a, 3b, 3d. Names and docs in render-three and input

- **3a:** only survivors' enemies are a crowd; push-puzzle draws its tile layers with the same class. `InstancedCrowd` became `MeshInstances`, which pairs with #24's sprite sibling.
- **3b:** the camera helpers' and `Stage`'s docs now say they work on the ground plane. `Stage` no longer offers the orthographic camera for a side view.
- **3d:** `MOVE_AXES`'s doc gives its signs: both axes follow screen space, and `moveY` is negative upward.

### 4. Unused exports and dependencies

- **What it was:** two core exports had no user, both apps declared `@gamekit/runtime` and never imported it, and some exports were kept for tests or kit-internal use with nothing saying so.
- **Fix:** core dropped `lerp` and `clampLength`; both apps dropped `@gamekit/runtime`. The exports that stay say why in their doc comments.
- **Left open:** which genre exports stay public is [#30](https://github.com/lucasthevenet/gamekit/issues/30), decided with #26's question on publishing genres. The clock's `alpha` goes with [#28](https://github.com/lucasthevenet/gamekit/issues/28).

### 5. Decisions that live only in prose

- **What it was:** the decisions #23 to #26 build on lived in the findings doc, the README or closed issues, so a follow-up couldn't say which one it overturns.
- **Fix:** `docs/adr/` with eight ADRs (listed above). Docs only.

### 7. Glossary drift

- **What it was:** kit docs used several words for the viewport, "snapshot" for a sample, "renderer" for a view and "game" for a genre. `CONTEXT.md`'s "Run" said the runtime ends a run, but both genres end their own.
- **Fix:** kit docs, the README and `CONTEXT.md` use the glossary's words, and `CONTEXT.md` gained entries such as Frame, Snapshot, Replay, Input source, View, Viewport, Content source and Kit. Both genres' `HudSnapshot` became `HudSample`.
- **Recorded, not changed:** app-only drift. Push-puzzle-demo's "Replay" button means "play again"; survivor-demo still says "Survivor Kit" and calls its last phase GameOver.

### 9. Views' unwritten rules about a run

- **What it was:** both views tell runs apart by object identity and never write the state, but `GameView`'s doc said neither.
- **Fix:** `GameView`'s doc gives three rules: `render` never changes the state, each run has its own state object, and a view may ignore `alpha`. `CONTEXT.md`'s "Run" says each run has its own state object. Docs only.

### 10. Event payloads typed twice

- **What it was:** genres exported plain interfaces and each app declared the same shapes again as Schemas, so a field added in a genre never reached the app.
- **Fix:** each genre declares its payloads once, as Schemas in its root entry's `events.ts`. The apps use them for their Model and Messages.

### 11. Every caller rebuilds the content recipe

- **What it was:** a genre's schema, file list and checks only came together inside its content layer, so three tests rebuilt them by hand.
- **Fix:** `@gamekit/content` adds `ContentDefinition`, and each genre exports one definition its layer and tests share.
- **Recorded:** the apps keep their copied Node file source. Sharing it needs a new entry point, which is #26's call.

### 13. Untested seams

- **What it was:** engine attach, stop and pause, `fitCamera` and all of `@gamekit/foldkit` had no tests, though both apps depend on them.
- **Fix:** `engine.test.ts` and `camera.test.ts` test them through their current interfaces. Foldkit's tests came with candidate 1, so they test the interface that stayed. `Stage` and the views stay untested until #24 decides how views get their assets.

## Separate issues

### 8. The step loop only runs inside `requestAnimationFrame`

- **What it was:** the step order lives in the frame callback, and two of `GameDefinition`'s fields take an `HTMLElement`. No test, Worker or server can run a genre's definition, and five tests rewrite the loop.
- **Why an issue:** splitting the DOM-free half from the browser frame reshapes `GameDefinition` and `GameDriver`. Decide it with #25's timer loop and #24's assets, before #26 freezes the interface: [#28](https://github.com/lucasthevenet/gamekit/issues/28).

### 12. The content loader caches failures

- **What it was:** `makeContentLoader` uses `Effect.cached`, which keeps failures too, so one failed fetch fails every later load.
- **Why an issue:** caching successes only changes `ContentLoader`'s documented behavior. Neither demo retries, so neither can see it today; #24's loading screen will: [#29](https://github.com/lucasthevenet/gamekit/issues/29).

## No action

- **2. Engine key and layer.** Each genre must declare its own service key for its identity, and the layer is already one expression.
- **3c. `SpatialGrid` docs.** Accurate, and only survivors uses it.
- **6. Survivors' `world.ts`.** One genre only. A split by section gives shallow modules on the wrong axis. #25 should restructure it in its first PR, per player against shared state.
- **14. The runtime can't see a run end.** Both genres end or freeze a run with a private flag, so the driver keeps stepping and survivors keeps sending the same HUD sample. Only survivors pays, and the fix changes the runtime contract. Recorded for #24 and #25; the glossary wording was fixed under candidate 7.

## Deviations

- **`replay.test.ts:8` still overstates coverage.** It says the replay guards runtime, core and input, but it calls the simulation directly. The file is kept byte-identical to `89665dc`, so the comment stays; #28 fixes it. The findings doc's matching line was corrected.
- **The CI comment.** `.github/workflows/ci.yml` still says "the demo's production build" where both demos build. This session couldn't change `.github/`.
- **`fitCamera` with a tilted perspective camera.** Writing its tests showed that a small tilt can push the near edge of the bounds off screen; the doc had promised extra room. The doc now says so and suggests more margin. Only push-puzzle uses `fitCamera`, with an orthographic camera, so there is no code change (ADR 0001).
- **The DOM-free check.** `tsconfig.root.json` checks a root entry with no DOM types, but nothing checks it imports no Three.js. `CONTEXT.md` now says keeping Three.js out is a convention. Recorded, no code change.
