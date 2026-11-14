# Testing an engine

`arcadekit/game/testing` has `ManualFrames`, a frame source a test drives: `ManualFrames.make()` makes one, and no frame runs until the test runs it with `ManualFrames.runFrameAt(frames, ms)`, at a time it chooses, so an engine steps and draws in Node with no `requestAnimationFrame`. Provide it as `Game.Frames`. Only tests import `arcadekit/game/testing`.

```ts
import * as Game from "arcadekit/game/browser";
import { ManualFrames } from "arcadekit/game/testing";
import { Effect, Layer, Schema } from "effect";

class Count extends Game.Simulation("Count", {
  // 1/64 s steps, so the frame times below are exact in floating point.
  stepSeconds: 1 / 64,
  input: Schema.Null,
  create: () => ({ steps: 0 }),
  step: (count) => {
    count.steps += 1;
  },
}) {}

// What the view drew, frame by frame.
const drawn: (number | null)[] = [];

class CountEngine extends Game.Engine("CountEngine", {
  simulation: Count,
  view: () => ({
    render: (count) => {
      drawn.push(count?.steps ?? null);
    },
    dispose: () => {},
  }),
  input: () => ({ read: () => null, dispose: () => {} }),
}) {}

const frames = ManualFrames.make();
// Node has no DOM, and this view touches nothing of its element.
const element = {} as HTMLElement;

// In a test: `await Effect.runPromise(play)`, then `expect(drawn).toStrictEqual([1, 2])`.
export const play = Effect.gen(function* () {
  const engine = yield* CountEngine;
  yield* engine.start(null, { seed: 1 });
  // Attached on a fiber of this scope. It has asked for its first frame when this returns.
  yield* Effect.forkScoped(engine.attach(element), { startImmediately: true });
  // 1/64 s after the attach: one step, then a draw. Then another.
  ManualFrames.runFrameAt(frames, 15.625);
  ManualFrames.runFrameAt(frames, 31.25);
}).pipe(
  Effect.scoped,
  Effect.provide(CountEngine.layer),
  Effect.provide(Layer.succeed(Game.Frames, frames))
);
```

`ManualFrames.waiting(frames)` says whether the engine has asked for a frame that hasn't run: it has while attached, and not after a detach or a crash. A Co-op client draws on the same frames ([Testing a Co-op game](coop.md)). To check the rules themselves, use [a scenario](scenarios.md): it needs no engine and no frames.
