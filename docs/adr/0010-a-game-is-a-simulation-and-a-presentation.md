---
status: accepted
---

> Amended by [ADR-0012](0012-delay-based-lockstep-over-a-host-star.md) on 2026-11-04: its open questions for #25 are settled. Pause and upgrade picks become step-scheduled inputs, and a lockstep peer's engine drives its device source's `endStep` and `endFrame` when it samples local input.

> Amended on 2026-11-06: `GameDriver` is gone. `makeGameEngine`'s `attach` is the `requestAnimationFrame` adapter now: an Effect that runs the frame loop until interrupted, with `FrameSource` as its frame clock. Each frame steps by `max(0, now - last)` and then draws, and a frame that throws ends the loop and the run with `GameCrashed`.

# A game is a DOM-free simulation and a browser presentation, stepped by one loop

The runtime's step order used to run only inside `GameDriver.attach`'s `requestAnimationFrame` closure: advance the clock, then `read` → `step` → `endStep` per step, `endFrame` once per frame that stepped, flush events, sample, render. And two of `GameDefinition`'s seven fields took the viewport element, so each genre's whole definition lived in `./browser`. No test, Worker or server could run a game the way the demo does. Five test files re-wrote the loop by hand without `endStep`, `endFrame` or samples, and neither genre's definition ran in any test (#28).

The game is now split in two.

- **`GameSimulation`** (`@gamekit/runtime`, DOM-free root entry) holds `stepSeconds`, `create`, `step`, `drainEvents` and `sample`. A genre exports one from its root entry: `survivorsSimulation`, `pushPuzzleSimulation`.
- **`GamePresentation`** (`@gamekit/runtime/browser`) holds `createInput` and `createView`. `GameDefinition` is now `GameSimulation & GamePresentation`. A genre's `./browser` entry builds it as `{ ...xSimulation, createInput, createView }` and keeps its old name (`survivorsGame`, `pushPuzzleGame`).

**`GameLoop`** (runtime root) runs a `GameSimulation`. It owns one run at a time, the step order, the fixed clock, the event flush and the samples. Its stepping entry point is `frame(input, budget, nowMs)`. Time and input come in as arguments, so it reads no global clock and names no DOM type. The runtime root has its own `tsconfig.root.json`, and every genre's root check now covers it too.

`frame` runs the step order in a fixed sequence, which `packages/runtime/src/loop.test.ts` pins with one interleaved call log:

- For each step the budget owes: `input.read(stepIndex)`, then `step`, then `endStep`.
- Then `endFrame`, once, if any step ran.
- Then the event flush.
- Then a sample: if `everyMs` has passed on `nowMs`, or else if `version` moved.

`frame` returns how many steps ran. For a `{ steps }` budget, 0 means none were consumed, because there was no run or it was paused, so the caller keeps them queued. A `{ seconds }` frame may also return 0 while its time is carried on the clock. The budget is one of:

- `{ seconds }`: the fixed clock. At most 0.25 s is counted, the remainder is carried, and the backlog is dropped after five steps.
- `{ steps }`: exactly that many steps. No clamp, no cap, no drop. It clears any remainder carried from `{ seconds }` frames.

Input reaches the loop as a `StepInput` (`read(step)`, `endStep?`, `endFrame?`). `InputSource` extends it with `dispose`, and it is what `createInput` returns. Scripts and lockstep buffers are plain `StepInput`s that index by the step number. Device sources ignore it.

`GameLoop.frame` is the seam where stepping adapters plug in. It has two adapters today:

- `GameDriver`, now the `requestAnimationFrame` adapter. Each frame it passes `{ seconds: (now - last) / 1000 }`, then calls `view.render(loop.state, now / 1000)`.
- Node tests: both replays, survivor-demo's content test and push-puzzle's browser input test, which pass `{ steps }` frames. The genres' rule tests (`world.test.ts`, survivors' `play` helper included) and push-puzzle-demo's solutions test still call `step` directly: they test the simulation's own interface, not the loop.

#25's timer or lockstep runner is the third. Inside `GameDriver`, a smaller seam, `FrameSource` (`now`, `request`), supplies frames and their times. It is `GameDriver`'s own frame clock: it times the driver's frames, which step by real time and then draw. It is not where stepping adapters plug in. A stepping adapter calls `GameLoop.frame`. It does not implement a `FrameSource`, which would step and draw on the same timer. `FrameSource` has two adapters:

- `animationFrames` (`requestAnimationFrame` and `performance.now`), the default, exported from `@gamekit/runtime/browser`. `makeGameEngine` takes another as `options.frames`.
- `manualFrames()`, which a test drives frame by frame. It is not public API: it lives in `@gamekit/runtime/testing`, an entry only tests import, and neither the root nor `./browser` exports it. A package export is the simplest form that serves both the runtime's tests and foldkit's, which import it by package name like any other workspace code. No test stubs `requestAnimationFrame` or spies on `performance.now` any more.

`GameEngine`'s interface is unchanged. It moves to `@gamekit/runtime/browser` with `makeGameEngine`, which gains `options.frames`. The apps' source doesn't import the runtime, so it doesn't change; survivor-demo's content test takes `@gamekit/runtime` as a devDependency.

`alpha` is gone from `GameView.render`, which is now `(state, timeSeconds)`, and from `FixedStepClock`. Neither view read it, interpolation needs previous positions that no state keeps (finding 12), and once stepping is decoupled from drawing nothing owns its meaning. `{ steps }` frames have no remainder at all. If a genre earns interpolation, it comes back as a read-only fraction offered by the adapter that owns the clock, with the two-genre evidence of [ADR-0001](0001-kit-changes-need-two-genres.md).

## Considered Options

- **Inject a frame source into today's `GameDriver` and leave stepping inside it** (the obvious minimal patch). Rejected, because stepping stays bound to `attach({ input, view })`. A replay, Worker or lockstep runner must carry a view to step and read the state back through a fake `render`, and #25 can't step without drawing.
- **A time-free session that counts samples in steps (`everySteps`).** It makes the core purer and samples deterministic. Rejected, because survivors' HUD cadence would change under frame hitches, and #28 forbids behaviour change. `nowMs` stays an argument instead.
- **Make `createInput` and `createView` generic over a surface type.** Rejected: the root entry would still carry view and input code.
- **A loop that schedules itself from an injected time source.** Rejected, because lockstep counts steps, not time. The caller decides when and how much to step.
- **Keep `alpha` for a future genre.** Rejected: it had no reader, and its meaning depends on which adapter owns the clock.

## Consequences

- **[ADR-0002](0002-genre-root-entries-are-dom-free.md) is amended.**
  - A genre's root entry now also holds its `GameSimulation` (with the sample policy).
  - `./browser` holds input, view, `GameDefinition` and the engine.
  - The runtime itself has a DOM-free root and a `./browser` entry.
  - Its "`GameDriver` is browser code" consequence for #25 is resolved: a Worker or server steps a run with the genre root plus `GameLoop`.
- **[ADR-0003](0003-one-fixed-step-clock.md) is amended.**
  - The fixed clock, the 0.25 s clamp and the backlog drop now all live in `GameLoop`'s `{ seconds }` path, not in a `requestAnimationFrame` loop.
  - `{ steps }` is the no-drop path lockstep requires.
  - Its consequence about `alpha` is superseded.
- **[ADR-0004](0004-one-press-one-step.md) is amended.**
  - `endFrame` runs once per `GameLoop.frame` call that ran a step, under either budget.
  - That settles the open question for #25: a lockstep tick that runs 0 steps while waiting skips `endFrame`. So a device source whose `endFrame` polls gamepads must be driven by whoever samples local input, and #25 decides that.
- **[ADR-0005](0005-samples-on-a-timer-or-a-version.md) is amended.**
  - `everyMs` counts on the `nowMs` the loop's caller passes in. That is the frame timestamp in the browser, so demo behaviour is unchanged.
- **Replays now go through the loop the demos run.**
  - Survivors' replay keeps its recorded hash `1_294_328_663`.
  - Push-puzzle's replay first recorded its expected result as a literal, which still matches after the move. It now also checks one HUD sample per turn.
  - Push-puzzle's press → turn mapping stays in `./browser`, because it reads `InputController`. It has a Node test through `GameLoop`.
- **#25 plugs in without another contract change.**
  - A timer or Worker calls `loop.frame(confirmedInputs, { steps: ready }, now)`, where `ready` is the count of steps whose inputs have all arrived.
  - `read(step)` returns the merged input for step N, and `stepIndex` gives the step number for desync hashing.
  - A sibling of `GameDriver` draws on `requestAnimationFrame` only.
  - A lockstep engine can return the same `GameEngine` interface.
  - "Two engines in one process" is two `GameLoop`s in Node.
  - Still open for #25: making `modify` and pause into step-scheduled inputs, and when `endFrame` runs for a peer whose local input sampling is separate from the stepping timer.
- **#24 fits unchanged.** A `makeSurvivorsGame(assets)` could spread `survivorsSimulation` and close over the loaded assets in a synchronous `createView`. An async `createView` would change only `GamePresentation`.
- **Imports move before #26 publishes.** `GameDefinition`, `GameView`, `GameEngine`, `makeGameEngine` and `GameDriver` now come from `@gamekit/runtime/browser`. `@gamekit/core` loses `FixedStepClock.alpha`. #26 decides whether `@gamekit/runtime/testing` ships at all; nothing outside tests may import it.
- **Rules for callers of `GameLoop`.**
  - `GameLoop.state` exposes the mutable run state. Callers read it and change it only through `modify`.
  - Listeners must not call `frame`, `start` or `modify` synchronously while an event is being delivered.
  - `{ steps }` has no cap, so a caller that passes a huge count blocks its thread.
