# arcadekit/game

A game's building blocks. Each part of a game is one named declaration: `Game.Event` for what a run reports, `Game.Command` for what a player decides, `Game.Rejection` for why the rules may refuse it, `Game.Simulation` for the rules, and, in `arcadekit/game/browser`, `Game.Engine` for the browser half that draws a run and reads its input. A declaration runs nothing by itself: a loop (`Game.makeLoop`) steps a simulation anywhere, an engine's `layer` provides it to an app, and a scenario (`arcadekit/game/scenario`) checks the rules in a test. `Game.PlayerInputs` is the step input of a simulation several players can play, and `Game.soloInput` fills it for one.

An entry of the [`arcadekit`](../../README.md) package. The root entry and `./scenario` are DOM-free. Import each as a namespace: `import * as Game from "arcadekit/game"`. `arcadekit/game/testing` has the frames a test drives an engine on, and only tests import it.

## Install

```bash
pnpm add arcadekit effect
```

Peer dependency: `effect` (~4.1).

## Its modules

Each export is reached through the entry's namespace, `Game.Event`, and `arcadekit/game/browser` has everything `arcadekit/game` has.

| Entry | Export | What it is | Guide |
| --- | --- | --- | --- |
| `arcadekit/game` | `Game.Event` | A declared event: what a run reports | [The simulation](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/simulation.md) |
| `arcadekit/game` | `Game.Command`, `Game.CommandDropped` | A declared command, what a player decides; and how a send fails when the rules gave no answer | [Commands and refusals](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/commands.md) |
| `arcadekit/game` | `Game.Rejection` | Why the rules may refuse a command | [Commands and refusals](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/commands.md) |
| `arcadekit/game` | `Game.Simulation` | The DOM-free rules, with `Game.StateOf`, `ConfigOf`, `InputOf`, `EventOf` and `CommandOf` for its types | [The simulation](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/simulation.md) |
| `arcadekit/game` | `Game.makeLoop`, `Game.Loop` | The loop that steps a simulation anywhere | [Steps and frames](https://github.com/lucasthevenet/arcadekit/blob/main/docs/concepts/steps-and-frames.md) |
| `arcadekit/game` | `Game.StepInput`, `Game.InputSource`, `Game.FrameBudget` | Where a frame's steps get their input, and how much a frame steps | [Steps and frames](https://github.com/lucasthevenet/arcadekit/blob/main/docs/concepts/steps-and-frames.md) |
| `arcadekit/game` | `Game.PlayerInputs`, `Game.soloInput`, `Game.playerInputSchema` | The step input of a simulation several players can play | [Several players](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/several-players.md) |
| `arcadekit/game/browser` | `Game.Engine`, `Game.EngineOf` | A simulation with the view and input source that draw it and read its input, as a service an app drives | [The engine](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/engine.md) |
| `arcadekit/game/browser` | `Game.View`, `Game.combineViews` | What draws a run into the viewport | [The engine](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/engine.md) |
| `arcadekit/game/browser` | `Game.Frames`, `Game.animationFrames`, `Game.frameLoop` | Where an attached engine gets its frames | [The engine](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/engine.md) |
| `arcadekit/game/browser` | `Game.AttachError`, `Game.GameCrashed` | How an attach fails | [The engine](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/engine.md) |
| `arcadekit/game/scenario` | `Scenario.make`, `given`, `step`, `send`, `reported`, `refused`, `sampled`, `state` | A specification of the rules you can run | [Scenarios](https://github.com/lucasthevenet/arcadekit/blob/main/docs/testing/scenarios.md) |
| `arcadekit/game/testing` | `ManualFrames` | A frame source a test drives | [Testing an engine](https://github.com/lucasthevenet/arcadekit/blob/main/docs/testing/engines.md) |

## Example

A runner moves by its input and reports when it passes the goal, stepped with no browser, as a replay or a server steps it:

```ts
import * as Game from "arcadekit/game";
import { Schema } from "effect";

class Finished extends Game.Event("Finished", { steps: Schema.Int }) {}

class Race extends Game.Simulation("Race", {
  input: Schema.Struct({ moveX: Schema.Number }),
  events: [Finished],
  create: () => ({ x: 0, finished: false }),
  step: (runner, input, { dt, step, report }) => {
    runner.x += input.moveX * 4 * dt;
    if (!runner.finished && runner.x >= 2) {
      runner.finished = true;
      report(new Finished({ steps: step + 1 }));
    }
  },
}) {}

// One second of steps with the stick held right: past the goal.
const loop = Game.makeLoop(Race);
loop.subscribe((event) => console.log(event._tag)); // Finished
loop.start(null, 1234, 0);
loop.frame({ read: () => ({ moveX: 1 }) }, { steps: 60 }, 1000);
```
