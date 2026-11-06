# @arcadekit/runtime

Runs a game. A game is a `GameSimulation` (the DOM-free half: create, step, events) plus, in the browser, its input and view. `GameLoop` steps a simulation anywhere: a browser, a Web Worker, a server or a test. `@arcadekit/runtime/browser` adds `GameDefinition` (simulation plus input and view) and `makeGameEngine`, the Effect API an app calls (`attach`, `listen`, `start`, `modify`, `setPaused`, `stop`), whose `attach` steps and draws the game on `requestAnimationFrame`. `makeEngineLoader` and `engineOf` make an engine from assets the app loads, such as a sprite sheet.

Part of [arcadekit](https://github.com/lucasthevenet/arcadekit#readme). The root entry is DOM-free.

## Install

```bash
pnpm add @arcadekit/runtime effect
```

Peer dependency: `effect` (~4.1).

## Example

A simulation, stepped without a browser, as a test or a replay does. The same seed and inputs give the same run:

```ts
import { GameLoop } from "@arcadekit/runtime";
import type { GameSimulation } from "@arcadekit/runtime";

interface State {
  x: number;
  readonly speed: number;
  readonly events: Event[];
}
type Input = { readonly moveX: number };
type Event = { readonly type: "hud"; readonly x: number };

export const simulation: GameSimulation<
  { readonly speed: number },
  State,
  Input,
  Event
> = {
  create: (config) => ({ x: 0, speed: config.speed, events: [] }),
  step: (state, input, dt) => {
    state.x += input.moveX * state.speed * dt;
  },
  drainEvents: (state) => state.events.splice(0),
  sample: { everyMs: 100, read: (state) => ({ type: "hud", x: state.x }) },
};

const loop = new GameLoop(simulation);
loop.subscribe((event) => console.log(event));
loop.start({ speed: 4 }, 1234, 0);
// 60 steps of scripted input: right for half a second, then still.
loop.frame(
  { read: (step) => ({ moveX: step < 30 ? 1 : 0 }) },
  { steps: 60 },
  1000
);
console.log(loop.state?.x); // about 2: half a second at speed 4
```

In the browser, the simulation plus input and a view make a `GameDefinition`, and `makeGameEngine` runs it behind an Effect service:

```ts
import type { GameSimulation } from "@arcadekit/runtime";
import { makeGameEngine } from "@arcadekit/runtime/browser";
import type { GameDefinition, GameEngine } from "@arcadekit/runtime/browser";
import { Context, Effect, Layer } from "effect";

interface State {
  ticks: number;
}

const simulation: GameSimulation<null, State, null, never> = {
  create: () => ({ ticks: 0 }),
  step: (state) => {
    state.ticks += 1;
  },
  drainEvents: () => [],
};

const game: GameDefinition<null, State, null, never> = {
  ...simulation,
  createInput: () => ({ read: () => null, dispose: () => {} }),
  createView: (container) => ({
    render: (state) => {
      container.textContent = state === null ? "" : String(state.ticks);
    },
    dispose: () => {
      container.textContent = "";
    },
  }),
};

class Engine extends Context.Service<Engine, GameEngine<null, State, never>>()(
  "my-game/Engine"
) {}
const EngineLayer = Layer.sync(Engine, () => makeGameEngine(game));

export const play = (element: HTMLElement) =>
  Effect.gen(function* () {
    const engine = yield* Engine;
    yield* engine.start(null);
    // Draws until interrupted, then detaches. Fails with AttachError if the view can't be made
    // (no WebGL), or with GameCrashed if a frame throws.
    return yield* engine.attach(element);
  }).pipe(Effect.provide(EngineLayer));
```

`attach` runs for as long as the engine stays attached: each animation frame steps the run by the time since the last frame, then draws it. Interrupt it to detach (fork it with `Effect.forkScoped` to do more while it runs). It never succeeds. It fails with `AttachError` (its `cause` is what was thrown) when `createView` or `createInput` throws, with nothing left attached, and with `GameCrashed` when a step, a render or an event listener throws: that frame is the last, and the view and input source are disposed. Either way the app can show the player why instead of a blank or frozen viewport. Attaching an engine that is already attached dies: an engine draws into one element at a time.

For tests, `@arcadekit/runtime/testing` has `manualFrames()`: pass it as `makeGameEngine(game, { frames })` and run each frame yourself with `runFrameAt(ms)`, with no `requestAnimationFrame`.

In a Foldkit app, `@arcadekit/foldkit` attaches the engine for you. See [ADR-0010](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0010-a-game-is-a-simulation-and-a-presentation.md) (a game is a simulation and a presentation), [ADR-0005](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0005-samples-on-a-timer-or-a-version.md) (samples) and [ADR-0015](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0015-pixel-art-sprites-loaded-by-the-app.md) (engines made from loaded assets).
