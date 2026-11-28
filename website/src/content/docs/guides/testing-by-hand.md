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

Each service a program provides from outside an app has a layer, `X.layer(implementation)`, and a stand-in its module makes for a test. The layer takes the contract in the last column, so a stand-in of your own implements it. `Test.make` provides the first four:

| Service | Layer | Stand-in | Contract |
| --- | --- | --- | --- |
| `Input.Source` | `Input.layer` | `Input.makeManualSource()` | `Input.Listener` |
| `Sound.Output` | `Sound.layer` | `Sound.makeRecorder()` | `Sound.Speaker` |
| `Assets.Loader` | `Assets.layer` | `Assets.makeMemory(files)` | `Assets.LoaderShape` |
| `View`'s UI | `View.mount(game, mount)` | the bridge it hands `mount` | `mount`, handed a `View.Bridge` |
| `Driver.Display` | `Driver.layer` | `Driver.makeManualDisplay()` | `Driver.DisplayShape` |
| `Transport.Transport` | `Transport.layer` | `Transport.makeHub().port(peer)` | `Transport.Listener` |
| `Three.Renderer` | `Three.layer` | `Three.makeRecorder()` | `Three.RendererShape` |

A driver takes contracts too. `Driver.fixedStep`, `interval`, `frames` and `run` step a `Driver.Tickable` or a `Driver.Paced`, and `Driver.run` closes a `Driver.Closes` when it ends. What must hold of the contracts of a page's devices and sound, and of a driver's, whoever implements them:

| Contract | Given by | What must hold |
| --- | --- | --- |
| [`Input.Listener`](/reference/arcadekit/Input#listener) | `Browser.layer` and `Browser.runMain`, from the page's keyboard, pointer and gamepads | `sample()` returns the devices' state, and what changed since the previous call. A button that went down and up between two calls is in `pressed` and in `released`, and not in `down`. An app calls it at most once a run of its input stage, so every system of the stage reads one sample. |
| [`Sound.Speaker`](/reference/arcadekit/Sound#speaker) | `Audio.layerSound`, `Browser.layer` and `Browser.runMain`, from the page's Web Audio | `play` starts a cue at once. `music` sets what a channel plays from then on, faded over `fade` seconds: a track that loops unless `once`, or silence for no track. `Sound.plugin` calls both in `"postFrame"`, and calls `music` only for a change. The apps under one layer share a speaker, so an app that closes tells each channel it plays on to play nothing, with no fade. |
| [`Driver.Tickable`](/reference/arcadekit/Driver#tickable) | `App.make`: an app | `tick(delta)` advances the game by `delta` seconds. A driver runs `input()` before each tick, and `frame(alpha, delta)` after the ticks of each step, when each is present. It reads `settled` only with `ticks: "whenNeeded"`. A tickable has no `hz`. |
| [`Driver.Paced`](/reference/arcadekit/Driver#paced) | `Session.make`, `Transport.connect` and `Replay.play` | It ticks at its own `hz`, so a driver takes no `hz` for it. `tick()` runs its input stage, then its next tick if that tick can run. While `lead` is 2 or more, a driver runs its ticks at half their rate. |
| [`Driver.Closes`](/reference/arcadekit/Driver#closes) | `Session.make`, `Transport.connect` and `Replay.play` | `close` lets go of everything it opened. `Driver.run` runs it when the run ends, however it ends. |

Provide a service's layer by hand to give an app one stand-in alone, or one of your own. To test slow loading, such as a loading screen, or a level left before its files arrived, provide a loader whose files arrive when the test decides:

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
