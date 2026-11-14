---
"arcadekit": minor
---

`arcadekit/game` is written as Effect's modules are, and every export of `arcadekit/game`, `arcadekit/game/browser`, `arcadekit/game/scenario` and `arcadekit/game/testing` has Effect's doc comment, with an example that runs. `Game.Event`, `Game.Command`, `Game.Rejection`, `Game.Simulation` and `Game.Engine` keep their builders, and a game declares its parts as before. **Breaking**: a loop is made with `Game.makeLoop`, the frames a test drives are the namespace `ManualFrames`, and the entry's three errors are `Schema.TaggedError`s.

What changed besides the names:

- **A loop is a host with a `TypeId`.** `Game.makeLoop(simulation)` makes a `Game.Loop`, with `pipe` and a printed form, and `Game.isLoop` tells one from a look-alike. Its methods (`start`, `send`, `setPaused`, `stop`, `subscribe`, `frame`) and its `state` and `stepIndex` are as they were, and so is every step it runs: no recorded hash moves.
- **The running engine is a value with a `TypeId`.** What `yield* MyEngine` gives has `pipe` and a printed form, and `Game.isEngine` recognises it. Its Effects are traced under the declared name: `MyEngine.attach`, `MyEngine.start`, `MyEngine.send`, `MyEngine.listen`, `MyEngine.setPaused` and `MyEngine.stop`.
- **The frame loop waits on each frame on its own.** `Game.frameLoop` asks for each frame with an `Effect.callback` that cancels it when interrupted, and is traced as `Game.frameLoop`. It still asks for the next frame in the call of the one that drew, so a test's `ManualFrames.runFrameAt` has run the whole frame when it returns. A failure of `attach` or of the frame loop carries the span in its cause: a test that compared the whole `Exit` with `Exit.fail(error)` compares the error instead (`Effect.flip`) or the cause's reasons.
- **`AttachError`, `GameCrashed` and `CommandDropped` are `Schema.TaggedError`s**, with the fields they had. An app catches each by its tag, as before.
- **The kernel under the loop is in the entry's `internal/`**, which no entry exports, as before.

```ts
import * as Game from "arcadekit/game/browser";
import { ManualFrames } from "arcadekit/game/testing";
import { Layer } from "effect";

// Before: const loop = new Game.Loop(Race);
const loop = Game.makeLoop(Race);

// Before: const frames = manualFrames();
const frames = ManualFrames.make();
const frameSource = Layer.succeed(Game.Frames, frames);

// Before: frames.runFrameAt(16) and frames.waiting()
ManualFrames.runFrameAt(frames, 16);
ManualFrames.waiting(frames);
```

**Breaking**

Every export that changed, and what a game writes now. The others keep their names and types.

| Before | Now |
| --- | --- |
| `new Game.Loop(simulation)` | `Game.makeLoop(simulation)` |
| `Game.Loop<...>`, a class | `Game.Loop<...>`, an interface with a `TypeId`; `Game.isLoop` is new |
| `Game.Engine<...>`, the running engine, an object of Effects | the same Effects, on a value with a `TypeId`; `Game.isEngine` is new |
| `Game.AttachError`, `Game.GameCrashed`, `Game.CommandDropped`, `Data.TaggedError`s | the same names and fields, `Schema.TaggedError`s |
| `manualFrames()` (`arcadekit/game/testing`) | `ManualFrames.make()` |
| `ReturnType<typeof manualFrames>` | `ManualFrames.ManualFrames`; `ManualFrames.isManualFrames` is new |
| `frames.runFrameAt(nowMs)` | `ManualFrames.runFrameAt(frames, nowMs)`, or `frames.pipe(ManualFrames.runFrameAt(nowMs))` |
| `frames.waiting()` | `ManualFrames.waiting(frames)` |
| `Scenario.ScenarioRunner<...>` | `Scenario.Runner<...>` |
| `Scenario.ScenarioStep<Runner>` | `Scenario.Step<Runner>` |
| `Scenario.ScenarioSteps<Runner>` | `Scenario.Steps<Runner>` |

The changelog keeps the old names: read it through this table.
