---
title: "Testing by hand"
description: "Some tests need more than Test.make provides. Learn how to run an app's frame stage by hand, provide a stand-in for devices, sound, files, the display, the network or the renderer yourself, and inspect what a game drew."
---

A test **by hand** is one that runs an app's frame stage itself, or provides a stand-in that `Test.make` doesn't: one of its own, a display, a network or a renderer. For a game under `Test.make` alone, see [testing](testing.md).

## Run the frame stage by hand

`app.frame()` runs the frame stage, and draws the game where its last tick left it. `app.frame(alpha)` draws it `alpha` of the way between its last two ticks, which a kind drawn with `smooth` shows. With `App.make(game, { verifyFrames: true })`, the app hashes the world before the stage and after each of its systems, and `frame` dies with `App.FrameChangedWorld`, which names the system, if a system changed the game. In every stage, `eachChunk` throws when a loop wrote a column it was handed read-only, and puts the column back. Each check costs a hash per system, or a copy of each column handed out read-only, so use it in tests.

To test a program that runs its own frame loop, provide `Driver.layer(Driver.makeManualDisplay())`, a display you drive by hand instead of real timers. `display.frame(ms)` signals that a frame is due, and `display.hide()` and `display.show()` act as the tab being hidden and shown again. `display.pending` and `display.watching` count the requested frames and the listeners on the tab, so a test can check that a stopped loop left nothing behind.

## Provide a stand-in by hand

```ts title="sound.test.ts"
import { expect, it } from "@effect/vitest";
import { App, Sound } from "arcadekit";
import { Effect } from "effect";

it.effect("plays nothing before the first frame", () =>
  Effect.gen(function* () {
    const sound = Sound.makeRecorder();
    const app = yield* App.make(App.define({ plugins: [Sound.plugin] })).pipe(
      Effect.provide(Sound.layer(sound))
    );
    yield* app.tick(1 / 60);
    expect(sound.played).toEqual([]);
  })
);
```

Each service a program provides from outside an app has a layer, `X.layer(implementation)`, and a stand-in its module makes for a test. `Test.make` provides the first four:

| Service | Layer | Stand-in |
| --- | --- | --- |
| `Input.Source` | `Input.layer` | `Input.makeManualSource()` |
| `Sound.Output` | `Sound.layer` | `Sound.makeRecorder()` |
| `Assets.Loader` | `Assets.layer` | `Assets.makeMemory(files)` |
| `View`'s UI | `View.mount(game, mount)` | the bridge it hands `mount` |
| `Driver.Display` | `Driver.layer` | `Driver.makeManualDisplay()` |
| `Transport.Transport` | `Transport.layer` | `Transport.makeHub().port(peer)` |
| `Three.Renderer` | `Three.layer` | `Three.makeRecorder()` |

Provide one by hand to give an app one stand-in alone, or one of your own. To test slow loading, such as a loading screen, or a level left before its files arrived, provide a loader whose files arrive when the test decides:

```ts
import { Assets } from "arcadekit";
import { Effect } from "effect";

const arrive = new Map<string, (bytes: Uint8Array) => void>();
export const slowLoader: Assets.LoaderShape = {
  bytes: (url) =>
    Effect.callback<Uint8Array, Assets.Failed>((resume) => {
      arrive.set(url, (bytes) => resume(Effect.succeed(bytes)));
    }),
};

/** A turn of the event loop, for what arrived to be decoded. */
export const settle = Effect.promise(
  () => new Promise((resolve) => setTimeout(resolve, 0))
);
```

Provide it with `Effect.provide(Assets.layer(slowLoader))`. The test steps the app while the files are in flight, calls `arrive.get("/forest.png")?.(bytes)`, and yields `settle` before it inspects the game. Such a test waits in real time, so run it with `it.live`.

## Record what is drawn

Give a game drawn with [`@arcadekit/three`](drawing-with-three.md) a renderer that draws nothing and records the scenes it is asked to render:

```ts sketch
const renderer = Three.makeRecorder();
const game =
  yield * Test.make(Arcade).pipe(Effect.provide(Three.layer(renderer)));
yield * game.step();
renderer.rendered[0]?.scene.getObjectByName("game/Rocks");
```

Three.js builds scenes and meshes under Node as it does in a page. After a frame, a test inspects what was added to the scene. An instanced mesh is named after its system, so `scene.getObjectByName("game/Rocks")` finds it.

## Read more

- [Testing](testing.md): a game under test with `Test.make`.
- [Testing several peers](testing-peers.md): a network in memory, and a check that a rewind runs a tick the same.
