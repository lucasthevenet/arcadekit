---
"arcadekit": minor
---

The older contract is gone, and with it the `runtime` entries. A game is its declarations ([ADR-0020](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0020-a-game-is-declared.md)): no game in the repository was on the older contract any more, and nothing of it is kept as a compatibility layer. What `arcadekit/runtime` had that a declared game still uses is `arcadekit/game`'s, under the same names. Nothing changed in how a run steps: the loop under `Game.Loop` is the same code, and no recorded hash moved.

**Breaking**

`arcadekit/runtime`, `arcadekit/runtime/browser` and `arcadekit/runtime/testing` are no longer entries of the package, which has nineteen. `arcadekit/game/testing` is new.

Each name they exported, and what to import or write in its place ([the `arcadekit/game` page](https://github.com/lucasthevenet/arcadekit/blob/main/packages/arcadekit/src/game/README.md) has each section):

| From `arcadekit/runtime` | Now |
| --- | --- |
| `StepInput`, `InputSource` | `arcadekit/game` (and `arcadekit/game/browser`): `Game.StepInput`, `Game.InputSource` |
| `FrameBudget` | `arcadekit/game`: `Game.FrameBudget` |
| `PlayerInputs`, `soloInput` | `arcadekit/game`: `Game.PlayerInputs`, `Game.soloInput` ("Several players") |
| `GameSimulation` | Gone: declare the game's rules with `Game.Simulation` ("The rules"). `create` takes `(config, { seed, report })`, `step` takes `(state, input, { dt, step, report })`, an event is a `Game.Event` class reported with `report` where there was `drainEvents`, and `sample` names its event and takes `every: "100 millis"` where there was `everyMs: 100` |
| `GameLoop` | Gone from the entries: step a declared simulation with `Game.Loop` ("How a frame becomes steps"). `new Game.Loop(MyGame)` has the same `start`, `frame`, `setPaused`, `stop`, `subscribe`, `state` and `stepIndex`. It has no `modify`: send a `Game.Command`, which the loop applies at the start of the next step ("Refusing a command") |

| From `arcadekit/runtime/browser` | Now |
| --- | --- |
| `AttachError`, `GameCrashed` | `arcadekit/game/browser`: `Game.AttachError`, `Game.GameCrashed`. The classes and their tags are the same, so an app's `Effect.catchTag("GameCrashed", ...)` and its `onError` are unchanged |
| `FrameSource`, `animationFrames` | `arcadekit/game/browser`: `Game.FrameSource`, `Game.animationFrames` |
| `GameView` | `arcadekit/game/browser`: `Game.View` |
| `combineViews` | `arcadekit/game/browser`: `Game.combineViews` |
| `StepInput`, `InputSource` | `arcadekit/game/browser`: `Game.StepInput`, `Game.InputSource` |
| `GameDefinition`, `GamePresentation` | Gone: declare the game's browser half with `Game.Engine` ("In the browser"). `createView` is `view` and `createInput` is `input`, each given what the engine `uses` |
| `makeGameEngine`, `GameEngine` | Gone: `class MyEngine extends Game.Engine("MyEngine", { simulation, uses, view, input }) {}`. The class is the engine service's key and `MyEngine.layer` provides it, so a genre writes no service and no layer for it; `Game.EngineOf<typeof MyGame>` names the running engine. `engine.modify` is `engine.send(command)`, which waits for the rules' answer. A send needs a step: it waits while the engine is paused or not attached, where `modify` changed the state at once, so a screen that paused the engine before a pick now leaves the run stepping and freezes the game in its rules ("Refusing a command"). `engine.start(config)` takes a seed too (`{ seed }`), and `makeGameEngine`'s `frames` option is the `Game.Frames` reference |
| `attachError` | Gone: `new Game.AttachError({ message, cause })` |
| `GameSimulation` | Gone: see above |
| `makeEngineLoader`, `EngineLoader`, `LoadedEngine`, `engineOf` | Gone: an `Asset` and a `Game.Engine` (the loaders' own entry in this changelog has each) |

| From `arcadekit/runtime/testing` | Now |
| --- | --- |
| `manualFrames` | `arcadekit/game/testing` ("Testing an engine"). Provide it as the engine's frames: `Layer.succeed(Game.Frames, manualFrames())` |

A game that imported only the names in the first rows of each table changes its import paths and nothing else. Before:

```ts
import type { StepInput } from "arcadekit/runtime";
import { combineViews } from "arcadekit/runtime/browser";
import type { GameView, InputSource } from "arcadekit/runtime/browser";
import { manualFrames } from "arcadekit/runtime/testing";
```

After, as `Game.StepInput`, `Game.combineViews`, `Game.View` and `Game.InputSource`:

```ts
import * as Game from "arcadekit/game/browser";
import { manualFrames } from "arcadekit/game/testing";
```

A game still built with `makeGameEngine` declares itself, as `@arcadekit/push-puzzle` does in [`src/simulation.ts`](https://github.com/lucasthevenet/arcadekit/blob/main/packages/push-puzzle/src/simulation.ts) and [`src/browser/game.ts`](https://github.com/lucasthevenet/arcadekit/blob/main/packages/push-puzzle/src/browser/game.ts):

```ts
// Before
const simulation: GameSimulation<Config, State, Input, Event> = {
  create: (config, seed) => createState(config, seed),
  step: (state, input, dt) => stepState(state, input, dt),
  drainEvents: (state) => state.events.drain(),
  sample: { everyMs: 100, read: (state) => ({ type: "hud", hp: state.hp }) },
};
const engine = makeGameEngine({ ...simulation, createInput, createView });
yield * engine.modify((state) => choose(state, index));

// After
export class Hud extends Game.Event("Hud", { hp: Schema.Number }) {}
export class Choose extends Game.Command("Choose", { index: Schema.Int }) {}

export class MyGame extends Game.Simulation("MyGame", {
  input: Input,
  commands: [Choose],
  create: (config: Config, { seed }) => createState(config, seed),
  step: (state, input, { dt }) => {
    stepState(state, input, dt);
  },
  apply: {
    Choose: (state, { index }) => {
      choose(state, index);
    },
  },
  sample: {
    event: Hud,
    every: "100 millis",
    read: (state) => ({ hp: state.hp }),
  },
}) {}

export class MyEngine extends Game.Engine("MyEngine", {
  simulation: MyGame,
  view: createView,
  input: createInput,
}) {}

const engine = yield * MyEngine; // provided by MyEngine.layer
yield * engine.send(new Choose({ index }));
```

**Unchanged**

- A run's step order, its fixed clock, the 0.25 s clamp and the five steps a frame may run: `Game.Loop` steps on the same kernel, which moved into `arcadekit/game` as it was and is exported from no entry.
- `arcadekit/foldkit`'s `engineEntry` and `gameViewport`, `arcadekit/net`'s lockstep session and its wire, and the `Coop` declaration.
- `makeSaveStore` and `makeAudioSettingsStore`: a save and the audio settings are not declarations yet.
