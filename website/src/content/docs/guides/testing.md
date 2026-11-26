---
title: "Testing"
description: "An arcadekit game runs under Node with nothing but its plugins, so its tests need no browser. Learn how to step an app and use stand-ins for devices, sound, files, rendering and the network."
---

An arcadekit game runs under Node with nothing but its plugins, so its **tests** need no browser. A test steps an app by hand, and gives it stand-ins for what a page provides: devices, sound, a display, files, a UI, a renderer and a network. The test drives each stand-in itself, so it controls when things happen and can inspect what the game asked for.

The examples use [Vitest](https://vitest.dev) with [`@effect/vitest`](https://github.com/Effect-TS/effect/tree/main/packages/vitest), whose `it.effect` runs a test that is an Effect. Each method of an app returns an Effect, and a test yields each one.

## Step an app

```ts title="rules.test.ts"
import { expect, it } from "@effect/vitest";
import { Action, App, Field, Plugin, Singleton } from "arcadekit";
import { Effect, Schema } from "effect";

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

it.effect("adds points", () =>
  Effect.gen(function* () {
    const app = yield* App.make(App.define({ plugins: [Rules] }));
    yield* app.enqueue(Add, { points: 3 });
    yield* app.tick(1 / 60);
    expect((yield* app.read(Score)).points).toBe(3);
  })
);
```

The test makes an app, steps it with `yield* app.tick`, and reads the game with `app.read`. `app.dispatch` applies an action at once, for testing a rule and its refusals: it fails with the refusal, and `yield* Effect.exit(app.dispatch(...))` gives the outcome as a value. A tick fails with what a system fails with, and a call made where it may not be, such as `app.tick` from inside a tick, dies with a message that says so.

A test changes the game as a player does, with an action. It sets the scene with a plugin of its own, whose `setup` spawns what the test needs. `app.read` takes `World`, `Time`, a query that only reads, a singleton or a state, and nothing that writes.

- An app has a scope of its own, so making one needs no `Effect.scoped`. It holds what it opened until `app.close`. The stand-ins below hold nothing. A test that opens something real, such as a page's devices or a socket, closes the app when it is done.
- Game time is `Time`, and a test advances it by ticking. `app.tick(1 / 60)` is a sixtieth of a second of game time, however long the test takes. Effect's `TestClock`, which `it.effect` provides, doesn't affect it. A test that waits in real time, on a socket or a timer of the page, is `it.live`.
- Vitest's `toEqual` treats two `Data.TaggedError` errors that differ only in their `message` as equal, since `message` isn't enumerable. When a test compares a failure, compare the `message` too.

## Drive the devices

```ts title="rules.test.ts"
import { Input } from "arcadekit";

it.effect("hears a key", () =>
  Effect.gen(function* () {
    const source = Input.makeManualSource();
    const app = yield* App.make(
      App.define({ plugins: [Rules, Input.plugin] })
    ).pipe(Effect.provide(Input.layer(source)));
    source.press("Space");
    yield* app.input(); // reads the devices
    yield* app.tick(1 / 60);
  })
);
```

By default, an app has no devices. A test provides a source it drives by hand. `source.press`, `release`, `tap` and `move` act as the devices. `app.input()` reads them, as a driver does in a page, and the next tick receives the input.

To test what a game does with a key, you don't need a device. Dispatch the action the key is bound to, or `Input.Report`, the action that updates the device state. When a source is also provided, the next `app.input()` reads it and overrides a report made by hand. A tick reads no device, so a test that runs `app.tick(delta)` alone keeps the report.

## Record the sound

```ts title="rules.test.ts"
import { Sound } from "arcadekit";

it.effect("plays nothing when nothing happens", () =>
  Effect.gen(function* () {
    const sound = Sound.makeRecorder();
    const app = yield* App.make(
      App.define({ plugins: [Rules, Sound.plugin] })
    ).pipe(Effect.provide(Sound.layer(sound)));
    yield* app.tick(1 / 60);
    yield* app.frame();
    expect(sound.played).toEqual([]);
  })
);
```

`Sound.makeRecorder()` is a speaker that plays nothing and records what it was asked: cues in `played`, what each music channel was told in `scored`, and what each channel is playing now in `playing`.

In a test, replace a sound that a page loads with `Browser.sound(url)` by an asset made with `Assets.make` that produces `Sound.clip(name)`. Replace a sound that a page streams with `Browser.stream(url)` by `Sound.clip(name)` itself. The recorder records each by that name.

## Run the frame stage by hand

`app.frame()` runs the frame stage, and draws the game where its last tick left it. `app.frame(alpha)` draws it `alpha` of the way between its last two ticks, which a kind drawn with `smooth` shows. With `App.make(game, { verifyFrames: true })`, the app hashes the world before the stage and after each of its systems, and `frame` dies with `App.FrameChangedWorld`, which names the system, if a system changed the game. In every stage, `eachChunk` throws when a loop wrote a column it was handed read-only, and puts the column back. Each check costs a hash per system, or a copy of each column handed out read-only, so use it in tests.

To test a program that runs its own frame loop, provide `Driver.makeManualDisplay()` as `Driver.Display`, a display you drive by hand instead of real timers. `display.frame(ms)` signals that a frame is due, and `display.hide()` and `display.show()` act as the tab being hidden and shown again. `display.pending` and `display.watching` count the requested frames and the listeners on the tab, so a test can check that a stopped loop left nothing behind.

## Serve files

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
export const settle = Effect.promise(
  () => new Promise((resolve) => setTimeout(resolve, 0))
);
```

Provide it with `Effect.provideService(Assets.Loader, slowLoader)`. The test steps the app while the files are in flight, calls `arrive.get("/forest.png")?.(bytes)`, and yields `settle` before it inspects the game. Such a test waits in real time, so run it with `it.live`.

To check that a level's assets are released when the level ends, give the level an asset made with `Assets.make`. Its `decode` records when the asset is created and, with `Effect.acquireRelease`, when it is released.

## Act as the UI

To test the game, the test acts as the UI. It provides `View.layer(game, (ui) => { handed.push(ui) })` to the app and keeps the bridge the app hands it. It subscribes to the views it reads, since a view that nothing listens to is computed only in the frame after `get` reads it. It reads them with `get` or its listeners, acts with `send`, and steps the app.

To test a UI, mount it with `View.layer` in a document, with `// @vitest-environment happy-dom` at the top of the file. Count what the UI was told, and count what changed in the document with a `MutationObserver`. See [a UI](ui.md).

## Record what is drawn

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

## Connect several peers

```ts sketch
const hub = Transport.makeHub({ delay: { min: 0, max: 4 }, seed: 1 });
const ada =
  yield * Transport.connect(adaSession).pipe(Effect.provide(hub.layer("ada")));
const grace =
  yield *
  Transport.connect(graceSession).pipe(Effect.provide(hub.layer("grace")));
for (let i = 0; i < 600; i++) {
  hub.step();
  yield * ada.tick();
  yield * grace.tick();
}
// No more input: let messages in flight arrive, then let the peer that is behind catch up.
for (let i = 0; i < 30; i++) {
  hub.step();
  yield * ada.tick();
  yield * grace.tick();
}
while (adaApp.time.tick !== graceApp.time.tick) {
  hub.step();
  yield * (adaApp.time.tick < graceApp.time.tick ? ada : grace).tick();
}
const adaWorld = yield * adaApp.read(World);
const graceWorld = yield * graceApp.read(World);
expect(adaWorld.hash()).toBe(graceWorld.hash());
expect(adaApp.actionLog).toEqual(graceApp.actionLog);
```

`Transport.makeHub({ delay, seed })` is an in-memory network. Nothing is lost, and nothing moves until the test calls `hub.step()`. Each message stays in flight for its delay, a number or a range, so messages can overtake each other. The same seed always produces the same network.

`hub.disconnect(peer)` cuts a peer off, as a socket that drops. What is on its way to the peer or from it is lost, and the others are told it left. `hub.reconnect(peer)` brings it back and tells every peer, as a relay does, so the sessions send again what was lost.

Compare peers once the game has settled and both are at the same tick. Stop issuing input, step a while longer, then tick only the peer that is behind. A single-player game that replays the same log with `Journal.replay` ends on the same hash.

## Check that a rewind runs the same

```ts sketch
const test = yield * Session.syncTest(Duel, { seed: 1 });
for (let i = 0; i < 600; i++) {
  yield * test.tick(1 / 60);
}
```

A session that runs ahead runs a tick again after a rewind, and a game that keeps something it reads outside the world runs it differently. `Session.syncTest(game, { seed })` finds such a tick with one app and no second peer. It makes the app and steps it, as a session does, and `test.app` is that app.

- Each tick is run, rewound and run again from the same moment.
- The world's hash is compared before the first system and after each one.
- `tick` fails with `Session.RewindDiverged`, which names the first system after which the hashes differ. A difference before any system is in a handler of an action queued for the tick, or in a state's hook.

The rest of the game sees each tick once: the frame and input stages, the action log and the recording. An action enqueued from outside is queued for the next tick, as in an app nobody took over. Each tick costs a capture of the game, a second run and a hash per system, so use it in tests.

## Check a game against its replay

Play a game in a test, replay its recording with `Journal.replay(recording, game)`, and assert that both end on the same hash. The replay catches a system that reads the clock or `Math.random`, at the first checkpoint after it does so. See [replays](replays.md).

## Read more

- arcadekit's own tests, in [`packages/arcadekit/test`](../../../../../packages/arcadekit/test), play games through every part of the package. [`test/Page.test.ts`](../../../../../packages/arcadekit/test/Page.test.ts) mounts the example page's two UIs in a document and plays the game through them.
