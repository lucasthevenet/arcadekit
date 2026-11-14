# The engine

`Game.Engine`, in `arcadekit/game/browser`, adds the browser half: the view that draws a run into the viewport element and the input source that reads each step's input from it. The class is the key of the engine service an app drives, and its `layer` provides it.

```ts
import * as Game from "arcadekit/game/browser";
import { Effect, Schema } from "effect";

export class Hud extends Game.Event("Hud", { x: Schema.Number }) {}

export class Race extends Game.Simulation("Race", {
  input: Schema.Struct({ moveX: Schema.Number }),
  create: () => ({ x: 0 }),
  step: (runner, input, { dt }) => {
    runner.x += input.moveX * 4 * dt;
  },
  sample: {
    event: Hud,
    every: "100 millis",
    read: (runner) => ({ x: runner.x }),
  },
}) {}

export class RaceEngine extends Game.Engine("RaceEngine", {
  simulation: Race,
  // What the view and the input source are made from: Effects run on each attach. A service
  // key is one, and so is an asset's load.
  uses: { color: Effect.succeed("#e0b040") },
  view: (container, { color }) => {
    const dot = document.createElement("div");
    dot.style.cssText = `position:absolute;width:16px;height:16px;background:${color}`;
    container.append(dot);
    return {
      // Reads the state on every frame; never changes it. No state between runs.
      render: (runner) => {
        dot.style.left = `${(runner?.x ?? 0) * 32}px`;
      },
      dispose: () => dot.remove(),
    };
  },
  input: () => {
    let moveX = 0;
    const onKey = (event: KeyboardEvent) => {
      if (event.code === "ArrowRight") {
        moveX = event.type === "keydown" ? 1 : 0;
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return {
      read: () => ({ moveX }),
      dispose: () => {
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("keyup", onKey);
      },
    };
  },
}) {}

// An app: start a run, hear its events, and draw it into an element until interrupted.
export const play = Effect.gen(function* () {
  const engine = yield* RaceEngine;
  yield* engine.listen(Race.match({ Hud: ({ x }) => console.log(x) }));
  yield* engine.start(null, { seed: 7 });
  return yield* engine.attach(document.body);
}).pipe(Effect.scoped, Effect.provide(RaceEngine.layer));
```

- **`uses`** names what the view and the input source are made from. Each Effect runs once per attach, in the attach's scope, before anything is made: the app's audio, a sprite sheet's load (an [`Asset`](content.md)), or something the view and the input share for that attach. The engine's `layer` needs their services, and a failure of one is `attach`'s.
- **`view`** and **`input`** are called once per attach, the view first, and disposed when the engine detaches, the input source first. Several views are one with `Game.combineViews`, such as a drawing view and a sound view: it renders each in order and disposes them in reverse. The view's third argument is `{ local }`, the local player's seat, which a view of a run several players share reads when it draws (`local.slot`): the engine seats its one player at slot 0, and a [`Coop`](coop.md), which plays the same engine for several players, at the slot its lobby gave.
- **A view** is a `Game.View`: `render(state, timeSeconds)` and `dispose`. `render` reads the state and never changes it, and gets no state (null) when no run is active. Each run has its own state object, made by `create`, and `render` gets that same object on every frame until the run ends, so a view tells runs apart by identity: push-puzzle's view resets when the object changes.
- **An input source** is a `Game.InputSource`: a `Game.StepInput` ([How a frame becomes steps](../concepts/steps-and-frames.md)) that owns what it listens with, and gives it back in `dispose`.
- **`engine.attach(element)`** steps the run by the time since the last frame, then draws it, on every animation frame. A first frame timed before the attach counts as no time. It never succeeds, so run it last: it fails with what a `uses` Effect fails with, with `AttachError` if the view or the input source can't be made (no WebGL), and with `GameCrashed` if a step, a render or a listener of the run's events throws. That frame is the last: the run ends, and the view and the input source are disposed, so the app can say why instead of showing a frozen viewport. Those failures reach only what waits on `attach`: a forked `attach` that nothing joins loses them, so join its fiber or race the rest of the program against it. Attaching an engine that is already attached dies: an engine draws into one element at a time.
- **`engine.start`**, `setPaused` and `stop` drive the run: while paused a frame draws but doesn't step, and paused time doesn't count. `engine.send` sends the run a command and waits for the rules' answer ([Refusing a command](commands.md)), and `engine.listen` hears its events and samples, in the order the run reports them: its callback is called inside the `start` or the frame that reports, before the frame draws and before a send that frame answered completes.
- **`Game.Frames`** is where an attached engine gets its frames: `requestAnimationFrame` (`Game.animationFrames`), unless the app or a test provides another `Game.FrameSource` ([Testing an engine](../testing/engines.md)).
- **`Game.frameLoop(frames, frame)`** is the loop an engine draws on, for anything else an app draws on animation frames. It fails with `GameCrashed` when a frame throws.

In a Foldkit app, [`arcadekit/foldkit`](foldkit.md)'s engine entry attaches the engine to the viewport and turns its events into Messages: `EngineEntry.make({ engine: RaceEngine, toMessage: Race.match({ ... }), ... })`.
