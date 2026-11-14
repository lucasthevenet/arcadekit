---
status: accepted
---

# One press reaches one step

> Amended by [ADR-0010](0010-a-game-is-a-simulation-and-a-presentation.md) on 2026-11-04: `GameLoop.frame` runs this step order under either budget, `endFrame` runs once per frame call that ran a step, and `packages/runtime/src/loop.test.ts` now checks the order and both behaviors.

> Amended by [ADR-0012](0012-delay-based-lockstep-over-a-host-star.md) on 2026-11-04: on a lockstep peer, the engine samples the local device source on its own schedule and calls its `endStep` and `endFrame`; `GameLoop` reads the buffer of merged inputs.

> Amended on 2026-11-06: `GameDriver` is gone; `makeGameEngine`'s `attach` is the `requestAnimationFrame` adapter, see the note on [ADR-0010](0010-a-game-is-a-simulation-and-a-presentation.md).

> Amended by [ADR-0020](0020-a-game-is-declared.md) on 2026-11-11: `makeGameEngine` and the `runtime` entries are gone. `Game.Loop` (`arcadekit/game`) runs this step order for every host, on the same `GameLoop`, now its kernel (`Kernel`); the test that checks the order is `packages/arcadekit/src/game/internal/kernel.test.ts`, and `StepInput` and `InputSource` are `arcadekit/game`'s. See the note on [ADR-0010](0010-a-game-is-a-simulation-and-a-presentation.md).

> Amended by [ADR-0024](0024-the-kit-is-written-as-effect-modules.md) on 2026-11-13: `arcadekit/input`'s controller is a namespace in Effect's shape, and the text below uses its names: a press is forgotten with `InputController.consumePresses(controller)`, and gamepads are polled by `InputController.endFrame(controller)`.

> Amended by [ADR-0024](0024-the-kit-is-written-as-effect-modules.md) on 2026-11-14: `arcadekit/game` is in Effect's shape, and the text below uses its names: the kernel and the test that checks the order are in `arcadekit/game`'s `internal/` (`internal/kernel.ts`, `internal/kernel.test.ts`), and a loop is made with `Game.makeLoop`.

A slow frame runs up to five catch-up steps, and presses used to be reset once per frame, so one press moved push-puzzle's player up to five cells and one undo undid up to five turns (#15, finding 1). `GameDriver` now calls `InputSource.endStep` after every step, and `endFrame` once per frame that ran a step. A source that needs one press to reach one step resets its presses in `endStep`, as push-puzzle does with `InputController.consumePresses(controller)`.

## Considered Options

- Call `endFrame` after every step. It was tried in #4 and reverted. It keeps the hook's name and type but changes when it runs, so the compiler can't flag it. Per-frame work in a source would then run up to five times a frame, and `InputController.endFrame(controller)` polls the gamepads.
- Make `read` report each press once. Every input source would then have to do this itself, as push-puzzle's first workaround did.

## Consequences

- For each step the driver calls `read`, `step`, then `endStep`. `endFrame` follows the frame's last `endStep`. `packages/runtime/src/runtime.test.ts` checks this order and both behaviors.
- A press made during a frame that runs no step waits for the next step.
- Survivors reads only axes, so it needs no `endStep`.
- #25 sends each step's input to the other peers. A press lands in exactly one step's input, so every peer applies it once.
- `endFrame` is tied to frames that ran a step. If #25 moves stepping off `requestAnimationFrame` ([ADR-0003](0003-one-fixed-step-clock.md)), it has to say when `endFrame` runs.
