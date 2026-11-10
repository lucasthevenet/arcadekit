---
"arcadekit": minor
---

A game is declared: one named class per part, hosted by a Layer or a loop ([ADR-0020](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0020-a-game-is-declared.md)).

**New entries**

- `arcadekit/game`: `Game.Event` and `Game.Command` (Schema classes for what a run reports and what a player decides), `Game.Rejection` (why the rules may refuse a command), `Game.Simulation` (the DOM-free rules: `input`, `events`, `commands`, `create`, `step`, `apply`, `sample`) and `Game.Loop`, which steps one anywhere. A command sent to a run is applied at the start of its next step, so a run changes only at a step. Its `apply` handler takes it or returns one of the rejections the command declares (`rejects`), and the sender is told which. A `step` or an `apply` handler that returns anything else is a type error, and the loop refuses it.
- `arcadekit/game/browser`: the same, plus `Game.Engine`: a simulation with the `view` and `input` that draw it and read its input, and what they are made from (`uses`, Effects run on each attach). The class is the engine service's key and its `layer` provides it. `engine.send(command)` completes when the rules have answered: it fails with the command's rejection if they refused it, and with `CommandDropped` if it never reached them. `Game.Frames` replaces the frame clock in a test. The sender goes on after the frame of the command's step, so it may start or stop a run. `Game.EngineOf<typeof MySimulation>` names the running engine.
- `arcadekit/game/scenario`: scenarios that check a simulation: `Scenario.given`, `step`, `send`, `reported`, `refused`, `sampled`, `state`.

**New in `arcadekit/content`**

- `Content(name, { schema, files, validate })` and `Asset<A, E>()(name, { release })`: content and loaded-once assets as classes that key their own service (`.layer`, `.load`; `Content` also has `.read` for tests). `loadOnce` is what both are built on.

**New in `arcadekit/runtime/browser`**

- `frameLoop(frames, frame)`, the loop an engine and the Co-op client draw on, for anything else an app draws on animation frames, and `steppedFrames`, the one an engine steps and draws with.

**Breaking**

- `arcadekit/foldkit`'s `engineEntry` no longer infers the app's Message type from `toMessage` and `onError`: it comes from `Subscription.make`. A call outside one names its type parameters. A `toMessage` that returns something that isn't a Message is now reported on `toMessage`.

`GameSimulation` and `makeGameEngine` are unchanged for now. They go once the Co-op client has moved to the declarations.
