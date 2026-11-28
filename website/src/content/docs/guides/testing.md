---
title: "Testing"
description: "An arcadekit game runs under Node with nothing but its plugins, so its tests need no browser. Learn how to make a game under test with Test.make, and drive its devices, record its sound, serve its files and act as its UI."
---

An arcadekit game runs under Node with nothing but its plugins, so its **tests** need no browser. A test steps an app by hand, and gives it stand-ins for what a page provides: devices, sound, files, a UI, a display, a renderer and a network. The test drives each stand-in itself, so it controls when things happen and can inspect what the game asked for.

The examples use [Vitest](https://vitest.dev) with [`@effect/vitest`](https://github.com/Effect-TS/effect/tree/main/packages/vitest), whose `it.effect` runs a test that is an Effect. Each method of an app returns an Effect, and a test yields each one.

## Make a game under test

```ts title="rules.test.ts"
import { expect, it } from "@effect/vitest";
import { Action, App, Field, Plugin, Singleton, Test } from "arcadekit";
import { Effect, Schema } from "effect";

const Score = Singleton.define(
  "game/Score",
  { points: Field.i32 },
  { points: 0 }
);
const Add = Action.define("game/Add", Schema.Struct({ points: Schema.Int }));
const add = Action.handler(Add, function* ({ points }) {
  (yield* Singleton.Write(Score)).points += points;
});
export const Rules = Plugin.make("game/Rules", {
  handlers: [add],
});

it.effect("adds points", () =>
  Effect.gen(function* () {
    const game = yield* Test.make(App.define({ plugins: [Rules] }));
    yield* game.app.enqueue(Add, { points: 3 });
    yield* game.step();
    expect((yield* game.app.read(Singleton.Read(Score))).points).toBe(3);
  })
);
```

`Test.make(game, options)` makes the game's app with a stand-in for each thing a page provides, and hands them back beside it: `game.input`, the devices, `game.sound`, what was played, `game.files`, where files come from, and `game.ui`, the bridge of a game with `View.plugin`. It takes how the app starts as `App.make` does, `seed` or `save`, with the `files` the game loads and the `delta` of a tick.

- `yield* game.step()` runs one frame of a driver that ticks every frame: the input stage, one tick, then the frame stage, which plays the sound and publishes the views.
- `yield* game.rest()` steps until the app is settled, as a driver that ticks only when needed would, and succeeds with the number of ticks it ran. It dies after 1000 ticks, or the limit it is given, for a game that never settles.
- `game.app` is the app itself. `app.dispatch` applies an action at once, for testing a rule and its refusals: it fails with the refusal, and `yield* Effect.exit(app.dispatch(...))` gives the outcome as a value. `app.read` takes `World`, `Time`, a query that only reads, a singleton or a state, and nothing that writes. A tick fails with what a system fails with, and a call made where it may not be, such as `app.tick` from inside a tick, dies with a message that says so.

A test changes the game as a player does, with an action. It sets the scene with a plugin of its own, whose `setup` spawns what the test needs.

- An app has a scope of its own, so making one needs no `Effect.scoped`. It holds what it opened until `app.close`. The stand-ins hold nothing. A test that opens something real, such as a page's devices or a socket, closes the app when it is done.
- Game time is `Time`, and a test advances it by ticking. A step is a sixtieth of a second of game time, however long the test takes. Effect's `TestClock`, which `it.effect` provides, doesn't affect it. A test that waits in real time, on a socket or a timer of the page, is `it.live`.
- Vitest's `toEqual` treats two `Data.TaggedError` errors that differ only in their `message` as equal, since `message` isn't enumerable. When a test compares a failure, compare the `message` too.

## Drive the devices

```ts title="rules.test.ts"
import { Input, System } from "arcadekit";

it.effect("hears a key and a stick", () =>
  Effect.gen(function* () {
    const Coin = Input.button("game/Coin", ["Space", Input.padButton(0, 0)]);
    const Lean = Input.axis("game/Lean", { pad: Input.padAxis(0, 0) });
    const Count = System.tick("game/Count", function* () {
      const score = yield* Singleton.Write(Score);
      if ((yield* Input.Read(Coin)).pressed) {
        score.points += 1;
      }
      if ((yield* Input.Read(Lean)) > 0.5) {
        score.points += 10;
      }
    });
    const game = yield* Test.make(
      App.define({
        plugins: [Rules, Input.controls("game/Controls", [Coin, Lean])],
        systems: [Count],
      })
    );
    game.input.press("Space");
    game.input.move(Input.padAxis(0, 0), 0.8);
    yield* game.step(); // reads the devices, then ticks
    expect((yield* game.app.read(Singleton.Read(Score))).points).toBe(11);
  })
);
```

`game.input` is a source the test drives by hand. `press`, `release`, `tap` and `move` act as the devices, with the codes a device gives, and each control follows the codes it is bound to. A step's input stage reads them, as a driver does in a page, and its tick receives what the controls said.

To test what a game does with a control, you don't need a device. Enqueue the action the game issues from it, or `Input.Report` with the control's name, such as `{ down: ["game/Coin"] }`. The next input stage reads the source and overrides a report made by hand, so a test that reports by hand ticks with `yield* game.app.tick(delta)`, which reads no device.

## Record the sound

```ts title="rules.test.ts"
import { Sound } from "arcadekit";

it.effect("plays nothing when nothing happens", () =>
  Effect.gen(function* () {
    const game = yield* Test.make(
      App.define({ plugins: [Rules, Sound.plugin] })
    );
    yield* game.step();
    expect(game.sound.played).toEqual([]);
  })
);
```

`game.sound` is a speaker that plays nothing and records what it was asked: cues in `played`, what each music channel was told in `scored`, and what each channel is playing now in `playing`. A step plays what its frame asked for.

A sound of a cue sheet needs no stand-in: the recorder records it by its name in the sheet, at the volume it was played at, its bus's included. In a test, replace a sound that a page loads with `Audio.sound(url)` by an asset made with `Assets.make` that produces `Sound.clip(name)`. The recorder records it by that name.

## Serve files

```ts title="rules.test.ts"
import { Assets } from "arcadekit";

it.effect("starts with the points the level's file says", () =>
  Effect.gen(function* () {
    const Level = Assets.bundle("game/Level", {
      start: Assets.json("/level.json", Schema.Int),
    });
    const Begin = Action.define("game/Begin", Schema.Int);
    const begin = Action.handler(Begin, function* (points) {
      (yield* Singleton.Write(Score)).points = points;
    });
    const game = yield* Test.make(
      App.define({
        plugins: [Rules, Assets.onReady(Level, begin, ({ start }) => start)],
        systems: [Assets.during(Level)],
      }),
      { files: { "/level.json": "5" } }
    );
    yield* game.step(); // loads the file in its frame
    yield* game.step(); // hands it to the rules
    expect((yield* game.app.read(Singleton.Read(Score))).points).toBe(5);
  })
);
```

`Test.make(game, { files })` serves the game's files from memory instead of `fetch`, and fails to load any other. A file given as text is read as UTF-8. A file from memory is loaded in the frame that asks for it, so a test of a level steps the game and needs no `it.live`.

To check that a level's assets are released when the level ends, give the level an asset made with `Assets.make`. Its `decode` records when the asset is created and, with `Effect.acquireRelease`, when it is released.

## Act as the UI

`game.ui` is the bridge the app hands its UI, for a game with `View.plugin`, and `undefined` for one without, which then doesn't compile where it is read. The test acts as the UI: it subscribes to the views it reads, since a view that nothing listens to is computed only in the frame after `get` reads it. It reads them with `get` or its listeners, acts with `send`, and steps the game.

To test a UI, mount it with `View.mount` in a document, with `// @vitest-environment happy-dom` at the top of the file. Count what the UI was told, and count what changed in the document with a `MutationObserver`. See [a UI](ui.md).

## Check a game against its replay

Play a game in a test, replay its recording with `Replay.verify(recording, game)`, and assert that both end on the same hash. The replay catches a system that reads the clock or `Math.random`, at the first hash check after it does so. See [replays](replays.md).

## Read more

- [Testing by hand](testing-by-hand.md): the frame stage run by hand, a stand-in of your own, and what a game drew.
- [Testing several peers](testing-peers.md): a network in memory, and a check that a rewind runs a tick the same.
- arcadekit's own tests, in [`packages/arcadekit/test`](../../../../../packages/arcadekit/test), play games through every part of the package. [`examples/page/src/page.test.ts`](../../../../../examples/page/src/page.test.ts) mounts the example page's two UIs in a document and plays the game through them.
