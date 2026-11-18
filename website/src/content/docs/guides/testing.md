---
title: "Testing"
description: "A game made with arcadekit runs under Node with nothing but its plugins, so its tests need no browser."
---

A game made with arcadekit runs under Node with nothing but its plugins, so its tests need no browser. This guide covers stepping an app in a test, and the stand-ins for what a page has: devices, sound, a display, files, a UI, a renderer and a network. A test works each stand-in by hand, so it says when a thing happens and sees what was asked.

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

- Game time is `Time`, and a test advances it by ticking: `app.tick(1 / 60)` is a sixtieth of a second of the game, however long the test took. Effect's `TestClock` does not move it.
- To Vitest's `toEqual`, two errors made with `Data.TaggedError` that differ only in their `message` are equal, since `message` is not an enumerable property. A test that compares a failure compares its `message` as well.

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

A test of what a game does with a key need not go through a device. It dispatches the action the key is bound to, or `Input.Report`, the action that keeps the picture of the devices. Where a source is provided as well, the next tick reads it and puts right a report made by hand: `app.tick(delta, { input: false })` is a tick that reads nothing and takes the report's word.

## Sound

`Sound.makeRecorder()` is an output that plays nothing and notes what it was asked: its cues in `played`, what each music channel was told in `scored`, and what each is playing now in `playing`.

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

A sound that a page loads with `Browser.sound(url)` is, in a test, an asset made with `Assets.make` that gives `Sound.clip(name)`. One that a page streams with `Browser.stream(url)` is `Sound.clip(name)` itself. The recorder notes each by that name.

## The frame stage

`app.frame(alpha)` runs the frame stage by hand. `App.make({ verifyFrames: true })` takes the world's hash before the stage and after each of its systems, and fails with `App.FrameChangedWorld` if one changed the game through a raw column. That costs a hash per system, so it is for tests.

A program that runs its own frame loop is given a display turned by hand, `Driver.makeManualDisplay()`, provided as `Driver.Display`, and never real timers. `display.frame(ms)` says a frame is due, and `display.hide()` and `display.show()` that the tab went away and came back. `display.pending` and `display.watching` count the frames asked for and the listeners on the tab, so a test sees that a loop it stopped left nothing behind.

## Files

`Assets.layerMemory({ "/level.json": "..." })` serves a test's files from memory in place of `fetch`.

A test of loading that takes time, a loading screen or a level left before its files came, provides an `Assets.Loader` of its own whose files arrive when the test says:

```ts
import { Assets } from "arcadekit";
import { Effect } from "effect";

const arrive = new Map<string, (bytes: Uint8Array) => void>();
export const slowLoader: Assets.LoaderShape = {
  bytes: (url) =>
    Effect.callback<Uint8Array, Assets.AssetFailed>((resume) => {
      arrive.set(url, (bytes) => resume(Effect.succeed(bytes)));
    }),
};

/** A turn of the event loop, for what arrived to be decoded. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
```

It is provided with `Effect.provideService(Assets.Loader, slowLoader)`. The test steps the app while the files are on their way, calls `arrive.get("/forest.png")?.(bytes)`, and waits for `settle()` before it looks. Such a test is asynchronous: it runs with `Effect.runPromise`. To see that a level's assets are let go when the level is left, give it an asset made with `Assets.make` whose `decode` notes when it is made and, with `Effect.acquireRelease`, when it is let go.

## A UI

A test of the game is the UI. It makes a bridge with `View.makeBridge()`, provides it with `Effect.provide(View.layer(ui))`, reads a view with `get` or `subscribe`, acts with `send`, and steps the app.

A test of a UI mounts it on a bridge in a document, with `// @vitest-environment happy-dom` at the top of its file, and counts what the UI was told and what changed in the document, with a `MutationObserver`. See [a UI](ui.md).

## What is drawn

A game drawn with [`@arcadekit/three`](drawing-with-three.md) is given a renderer that draws nothing and notes the scene it was handed:

```ts
import { Three } from "@arcadekit/three";
import { Layer } from "effect";
import type { Scene } from "three";

export const drawn: Scene[] = [];
export const noRenderer = Layer.succeed(Three.Renderer, {
  render(scene) {
    drawn.push(scene);
  },
});
```

Three.js makes its scenes and meshes under Node as in a page. After `app.frame(alpha)`, a test looks at what was put in the scene. A mesh of instances has the name of its system, so `scene.getObjectByName("game/Rocks")` finds it.

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

- The package's own tests, [`packages/arcadekit/test`](../../../../../packages/arcadekit/test), play games through every part of it. [`test/page.test.ts`](../../../../../packages/arcadekit/test/page.test.ts) mounts the example page's two UIs in a document and plays the game through them.
