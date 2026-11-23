---
title: "Testing"
description: "An arcadekit game runs under Node with nothing but its plugins, so its tests need no browser. Learn how to step an app and use stand-ins for devices, sound, files, rendering and the network."
---

An arcadekit game runs under Node with nothing but its plugins, so its tests need no browser. This guide covers stepping an app in a test, and the stand-ins for what a page provides: devices, sound, a display, files, a UI, a renderer and a network. A test drives each stand-in by hand, so it controls when things happen and can inspect what was requested.

The examples use [Vitest](https://vitest.dev), but any test runner works.

## Stepping an app

An app is created inside a scope. A test creates it, steps it with `tick`, and reads the game with `app.read`:

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
  (yield* Score.writes).points += points;
});
export const Rules = Plugin.make("game/Rules", {
  handlers: [add],
});

export const play = <A>(body: Effect.Effect<A, unknown, Scope.Scope>) =>
  Effect.runSync(Effect.scoped(body));

it("adds points", () =>
  play(
    Effect.gen(function* () {
      const app = yield* App.make(App.define({ plugins: [Rules] }));
      app.enqueue(Add, { points: 3 });
      app.tick(1 / 60);
      expect((yield* app.read(Score)).points).toBe(3);
    })
  ));
```

`app.dispatch` returns an action's outcome immediately, for testing a rule and its refusals.

A test changes the game as a player does, with an action, and sets the scene with a plugin of its own whose `setup` spawns what the test needs. `app.read` takes `World`, `Time`, a query that only reads, a singleton or a state, and nothing that writes.

- Game time is `Time`, and a test advances it by ticking: `app.tick(1 / 60)` is a sixtieth of a second of game time, however long the test takes. Effect's `TestClock` doesn't affect it.
- Vitest's `toEqual` treats two `Data.TaggedError` errors that differ only in their `message` as equal, since `message` isn't enumerable. When a test compares a failure, it compares the `message` too.

## Devices

By default, an app has no devices. A test provides a source it drives by hand:

```ts title="rules.test.ts"
import { Input } from "arcadekit";

it("hears a key", () =>
  play(
    Effect.gen(function* () {
      const source = Input.makeManualSource();
      const app = yield* App.make(
        App.define({ plugins: [Rules, Input.plugin] })
      ).pipe(Effect.provide(Input.layer(source)));
      source.press("Space");
      app.input(); // reads the devices
      app.tick(1 / 60);
    })
  ));
```

`source.press`, `release`, `tap` and `move` simulate the devices. `app.input()` reads them, as a driver does in a page, and the following tick receives the input.

To test what a game does with a key, you don't need a device. Dispatch the action the key is bound to, or `Input.Report`, the action that updates the device state. When a source is also provided, the next `app.input()` reads it and overrides a report made by hand. A tick reads no device, so a test that calls `app.tick(delta)` alone keeps the report.

## Sound

`Sound.makeRecorder()` is an output that plays nothing and records what it was asked: cues in `played`, what each music channel was told in `scored`, and what each is playing now in `playing`.

```ts title="rules.test.ts"
import { Sound } from "arcadekit";

it("plays nothing when nothing happens", () =>
  play(
    Effect.gen(function* () {
      const sound = Sound.makeRecorder();
      const app = yield* App.make(
        App.define({ plugins: [Rules, Sound.plugin] })
      ).pipe(Effect.provide(Sound.layer(sound)));
      app.tick(1 / 60);
      app.frame(1);
      expect(sound.played).toEqual([]);
    })
  ));
```

In a test, replace a sound a page loads with `Browser.sound(url)` by an asset made with `Assets.make` that produces `Sound.clip(name)`, and a sound a page streams with `Browser.stream(url)` by `Sound.clip(name)` itself. The recorder records each by that name.

## The frame stage

`app.frame(alpha)` runs the frame stage by hand. `App.make(game, { verifyFrames: true })` hashes the world before the stage and after each of its systems, and fails with `Stage.FrameChangedWorld` if one changed the game through a raw column. It costs a hash per system, so use it in tests.

To test a program that runs its own frame loop, provide a display you drive by hand, `Driver.makeManualDisplay()`, as `Driver.Display`, instead of real timers. `display.frame(ms)` signals that a frame is due, and `display.hide()` and `display.show()` simulate the tab being hidden and shown again. `display.pending` and `display.watching` count the requested frames and the listeners on the tab, so a test can check that a stopped loop left nothing behind.

## Files

`Assets.layerMemory({ "/level.json": "..." })` serves a test's files from memory instead of `fetch`.

To test slow loading, such as a loading screen, or a level left before its files arrived, provide your own `Assets.Loader` whose files arrive when the test decides:

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

Provide it with `Effect.provideService(Assets.Loader, slowLoader)`. The test steps the app while the files are in flight, calls `arrive.get("/forest.png")?.(bytes)`, and awaits `settle()` before inspecting. Such a test is asynchronous, so run it with `Effect.runPromise`. To check that a level's assets are released when the level ends, give it an asset made with `Assets.make` whose `decode` records when it is created and, with `Effect.acquireRelease`, when it is released.

## A UI

To test the game, the test acts as the UI. It creates a bridge from the game with `View.makeBridge(game)`, provides it with `Effect.provide(View.layer(ui))`, reads views with `get` or `subscribe`, acts with `send`, and steps the app.

To test a UI, mount it on a bridge in a document, with `// @vitest-environment happy-dom` at the top of the file, and count what the UI was told and what changed in the document with a `MutationObserver`. See [a UI](ui.md).

## Rendering

Give a game drawn with [`@arcadekit/three`](drawing-with-three.md) a renderer that draws nothing and records the scene it receives:

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

Three.js builds scenes and meshes under Node as it does in a page. After `app.frame(alpha)`, a test inspects what was added to the scene. An instanced mesh is named after its system, so `scene.getObjectByName("game/Rocks")` finds it.

## Several peers

`Transport.makeHub({ delay, seed })` is an in-memory network. Nothing is lost, and nothing moves until the test calls `hub.step()`. Each message stays in flight for its delay, a number or a range, so messages can overtake each other, and the same seed always produces the same network.

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
// No more input: let messages in flight arrive, then let the peer that is behind catch up.
for (let i = 0; i < 30; i++) {
  hub.step();
  ada.tick();
  grace.tick();
}
while (adaApp.time.tick !== graceApp.time.tick) {
  hub.step();
  (adaApp.time.tick < graceApp.time.tick ? ada : grace).tick();
}
const adaWorld = yield * adaApp.read(World);
const graceWorld = yield * graceApp.read(World);
expect(adaWorld.hash()).toBe(graceWorld.hash());
expect(adaApp.actionLog).toEqual(graceApp.actionLog);
```

`hub.disconnect(peer)` cuts a peer off, as a socket that drops: what is on its way to it or from it is lost, and the others are told it left. `hub.reconnect(peer)` brings it back, and every peer is told, as a relay tells them, so the sessions send again what was lost.

Compare peers once the game has settled and both are at the same tick: stop issuing input, step a while longer, then tick only the peer that is behind. A single-player game replaying the same log with `Journal.replay` must end on the same hash.

## Rewinds

A session that runs ahead runs a tick again after a rewind, and a game that keeps something it reads outside the world runs it differently. `Session.syncTest(game, { seed })` finds that with one app and no second peer. It makes the app and steps it, as a session does, and `test.app` is that app:

```ts sketch
const test = yield * Session.syncTest(Duel, { seed: 1 });
for (let i = 0; i < 600; i++) {
  test.tick(1 / 60);
}
```

- Each tick is run, rewound and run again from the same moment.
- The world's hash is compared before the first system and after each one.
- `tick` throws `Session.RewindDiverged`, which names the first system after which the hashes differ. A difference before any system is in a handler of an action queued for the tick, or in a state's hook.

The rest of the game sees each tick once: the frame and input stages, the action log and the recording. An action enqueued from outside is queued for the next tick, as in an app nobody took over. Each tick costs a capture of the game, a second run and a hash per system, so use it in tests.

## Replays as tests

Play a game in a test, replay its recording with `Journal.replay(recording, game)`, and assert that both end on the same hash. This catches a system that reads the clock or `Math.random`, at the tick it does so. See [replays](replays.md).

## Read more

- arcadekit's own tests, in [`packages/arcadekit/test`](../../../../../packages/arcadekit/test), play games through every part of the package. [`test/Page.test.ts`](../../../../../packages/arcadekit/test/Page.test.ts) mounts the example page's two UIs in a document and plays the game through them.
