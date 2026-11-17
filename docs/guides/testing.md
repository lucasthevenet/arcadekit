# Testing

A game made with arcadekit runs under Node with nothing but its plugins, so its tests need no browser. This guide covers stepping an app in a test, and the stand-ins for what a page has: devices, sound, a display, files, and a network.

The examples use [Vitest](https://vitest.dev). Any runner works.

## Stepping an app

An app is made inside a scope. A test makes it, steps it with `tick`, and looks at the world:

```ts title="rules.test.ts"
import { Action, App, Field, Plugin, Singleton } from "arcadekit";
import { Effect, Schema } from "effect";
import type { Scope } from "effect";
import { expect, it } from "vitest";

const Score = Singleton.define(
  "game/Score",
  { points: Field.i32 },
  { points: 0 }
);
const Add = Action.define("game/Add", Schema.Struct({ points: Schema.Int }));
const add = Action.handler(Add, function* ({ points }) {
  (yield* Score).points += points;
});
export const Rules = Plugin.make("game/Rules", {
  components: [Score],
  handlers: [add],
});

export const play = <A>(body: Effect.Effect<A, unknown, Scope.Scope>) =>
  Effect.runSync(Effect.scoped(body));

it("adds points", () =>
  play(
    Effect.gen(function* () {
      const app = yield* App.make({ plugins: [Rules] });
      app.enqueue(Add, { points: 3 });
      app.tick(1 / 60);
      expect(app.world.singleton(Score).points).toBe(3);
      expect(app.conflicts).toEqual([]);
    })
  ));
```

`app.dispatch` returns an action's outcome at once, for a test of a rule and its refusals. `app.conflicts` lists systems whose order nothing says; holding it to empty catches an order that only works by accident. See [systems](systems.md#saying-what-a-system-touches).

## Devices

By default an app has no devices. A test provides a source worked by hand:

```ts title="rules.test.ts"
import { Input } from "arcadekit";

it("hears a key", () =>
  play(
    Effect.gen(function* () {
      const source = Input.makeManualSource();
      const app = yield* App.make({ plugins: [Rules, Input.plugin] }).pipe(
        Effect.provideService(Input.Source, source)
      );
      source.press("Space");
      app.tick(1 / 60); // hears the devices first
    })
  ));
```

`source.press`, `release`, `tap` and `move` say what the devices do. The tick that follows hears it, as a page's would.

## Sound

`Sound.makeRecorder()` is an output that plays nothing and notes what it was asked: its cues in `played`, and each music channel in `playing`.

```ts title="rules.test.ts"
import { Sound } from "arcadekit";

it("plays nothing when nothing happens", () =>
  play(
    Effect.gen(function* () {
      const sound = Sound.makeRecorder();
      const app = yield* App.make({ plugins: [Rules, Sound.plugin] }).pipe(
        Effect.provide(Sound.layer(sound))
      );
      app.tick(1 / 60);
      app.frame(1);
      expect(sound.played).toEqual([]);
    })
  ));
```

## The frame stage

`app.frame(alpha)` runs the frame stage by hand. `App.make({ verifyFrames: true })` takes the world's hash before the stage and after each of its systems, and fails with `App.FrameChangedWorld` if one changed the game through a raw column. That costs a hash per system, so it is for tests.

A program that runs its own frame loop is given a display turned by hand, `Driver.makeManualDisplay()`, provided as `Driver.Display`. `display.frame(ms)` says a frame is due, and `display.hide()` that the tab went away.

## Files

`Assets.layerMemory({ "/level.json": "..." })` serves a test's files from memory in place of `fetch`.

## A UI

`View.makeBridge()` makes a bridge a test can read with `get` and act on with `send`, as a UI would.

## Several peers

`Transport.makeHub({ delay, seed })` is a network in memory. Nothing is lost and nothing moves until the test calls `hub.step()`. A message stays on its way for its delay, a number or a range, so messages overtake each other, and the same seed is the same network.

```ts sketch
const hub = Transport.makeHub({ delay: { min: 0, max: 4 }, seed: 1 });
const ada =
  yield * Transport.connect(adaSession).pipe(Effect.provide(hub.layer("ada")));
const grace =
  yield *
  Transport.connect(graceSession).pipe(Effect.provide(hub.layer("grace")));
for (let i = 0; i < 600; i++) {
  hub.step();
  ada.tick();
  grace.tick();
}
expect(adaApp.world.hash()).toBe(graceApp.world.hash());
```

## Replays as tests

A game played in a test, then replayed into a fresh app with `App.replay`, has to end on the same hash. That catches a system that reads the clock or `Math.random` at the tick it does it. See [replays](replays.md).

## Read more

- The package's own tests, [`packages/arcadekit/test`](../../packages/arcadekit/test), play games through every part of it. [`test/page.test.ts`](../../packages/arcadekit/test/page.test.ts) mounts the example page's two UIs in a document and plays the game through them.
