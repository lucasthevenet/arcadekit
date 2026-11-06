---
"@arcadekit/runtime": minor
"@arcadekit/foldkit": minor
---

The browser frame loop is an Effect now. `GameEngine.attach(element)` makes the view and the input source, then runs the frame loop itself for as long as it stays attached: each frame waits for the next animation frame, steps the run, then draws, all in one go. A frame whose step, render or event listener throws is the last one: the run ends, the loop asks for no more frames, the view and input source are disposed, and `attach` fails with the new `GameCrashed` (exported from `@arcadekit/runtime/browser`, with the thrown `cause`). Before, the loop kept running after a throw and nothing on the Effect side was told. The first frame no longer steps by a negative time when `requestAnimationFrame`'s time is before attach.

`engineEntry` runs `attach` instead of waiting forever after it, so a crash reaches `onError` as a Message, sent once, like a failed attach.

Breaking:

- `GameEngine.attach` is `(element) => Effect<never, AttachError | GameCrashed>` (was `Effect<void, never, Scope>`). It runs until interrupted instead of returning once attached, and it needs no `Scope`. Interrupt it to detach. It fails with `AttachError` when `createView` or `createInput` throws, and with `GameCrashed` when a frame throws. It never succeeds, so run it last: start the run, then `return yield* engine.attach(element)`. Its failures reach only what waits on it: a forked `attach` that nothing joins (`Effect.forkScoped(engine.attach(element))` alone) loses them silently, so join its fiber (`Fiber.join`) or race the rest of the program against it (`Effect.raceFirst(rest, engine.attach(element))`).
- A crash ends the run, as `stop` does: attached again, the engine draws no run until the app starts a new one. Before, the run stayed live after a throw, and the next frame ran the step that threw again.
- `AttachableEngine<Event, E>.attach` is `(element) => Effect<never, E>` (was `Effect<void, E, Scope>`): it runs until interrupted, and fails with `E` if it can't attach or stops on its own. An engine that draws on its own timer ends its `attach` with `Effect.never`, scoped.
- `onError` in `engineEntry` for a `GameEngine` (or `engineOf(loader)`) also receives `GameCrashed`.
- `GameDriver` is removed from `@arcadekit/runtime/browser`. Use `makeGameEngine` to step and draw in the browser, or `GameLoop` to step without drawing.
