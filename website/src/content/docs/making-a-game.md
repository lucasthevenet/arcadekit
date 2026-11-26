---
title: "Making a game"
description: "Build a small game from scratch: coins fall, a basket catches them, and three missed coins end the game. You run it in a test first, then in a page."
---

In this walkthrough you build a small game from scratch: coins fall, a basket catches them, and three missed coins end the game. You run it in a test first, then in a page.

Along the way you use most of arcadekit: components, a singleton, systems, a control the player steers with, an action and its refusal, an event, a plugin, a replay, and a frame stage that draws. Each part has a guide of its own.

## Install

```sh
pnpm add arcadekit effect @effect/platform-browser
pnpm add -D vitest @effect/vitest
```

arcadekit is built on [Effect](https://effect.website) 4. `@effect/platform-browser` runs your game in a page. Running under Node, in a test or on a server, needs nothing more.

## The rules

A game's rules are a plugin: its components, its systems, what a player can do, and what runs at startup.

Start with the data. A coin is an entity with a position and a falling speed. There is only one basket, so instead of an entity it is a singleton.

```ts title="rules.ts"
import {
  Action,
  Commands,
  Component,
  Event,
  Field,
  Input,
  Plugin,
  Query,
  Random,
  Singleton,
  System,
  Time,
  Timer,
} from "arcadekit";
import { Effect, Schema } from "effect";

export const Position = Component.define("catch/Position", {
  x: Field.f32,
  y: Field.f32,
});
export const Fall = Component.define("catch/Fall", { speed: Field.f32 });

export const Basket = Singleton.define(
  "catch/Basket",
  { x: Field.f32, caught: Field.i32, lives: Field.i32 },
  { x: 0, caught: 0, lives: 3 }
);
```

A component's fields are stored as numbers in typed arrays. Its name, `"catch/Position"`, is its identity, and saves refer to it by that name.

Next come the systems. A system runs once per tick as one Effect, and loops over the entities its query matches with a plain function. It reads the time from `Time`, never from the system clock.

```ts title="rules.ts"
const BASKET_WIDTH = 1;
const BASKET_SPEED = 6;

const Coins = Query.all(Position, Fall).pipe(Query.writes(Position));

const Drop = System.tick("catch/Drop", function* () {
  const { delta } = yield* Time;
  (yield* Coins).each((position, fall) => {
    position.y -= fall.speed * delta;
  });
});
```

When a coin reaches the ground, it is caught or missed, and despawned either way. You despawn an entity through `Commands`, which applies the change after the system finishes, so the world never changes under a running loop.

```ts title="rules.ts"
export const Caught = Event.define(
  "catch/Caught",
  Schema.Struct({ total: Schema.Int })
);

const Land = System.tick("catch/Land", function* () {
  const basket = yield* Basket.writes;
  const commands = yield* Commands;
  const caught = yield* Caught.emits;
  (yield* Coins).each((position, _fall, coin) => {
    if (position.y > 0) {
      return;
    }
    if (Math.abs(position.x - basket.x) <= BASKET_WIDTH / 2) {
      basket.caught += 1;
      caught.emit({ total: basket.caught });
    } else {
      basket.lives = Math.max(0, basket.lives - 1);
    }
    commands.despawn(coin);
  });
});
```

`Caught` is an event, a record that something happened, for any system that wants to react. The rules play no sound themselves. A [sound](guides/sound.md) plugin can play a cue from this event in the frame stage.

## What a player can do

The player steers the basket. A **control** names what a player does, here an axis from -1 to 1, and binds it to the devices: two keys each way and a gamepad's stick. The rules read the control and never a key, so the keys can change without a change to the rules.

```ts title="rules.ts"
export const Move = Input.axis("catch/Move", {
  negative: ["ArrowLeft", "KeyA"],
  positive: ["ArrowRight", "KeyD"],
  pad: Input.padAxis(0, 0),
});

const Steer = System.tick("catch/Steer", function* () {
  const basket = yield* Basket.writes;
  if (basket.lives === 0) {
    return;
  }
  const { delta } = yield* Time;
  basket.x += (yield* Move) * BASKET_SPEED * delta;
});
```

`yield* Move` is 1 while a right key is held, -1 while a left one is, 0 while both or neither are, and how far the stick is pushed. Before each tick the app reads the devices and reports what the control says as an action, so every system of the tick reads the same value, and a replay reads it from the log with no keyboard at all.

A player changes the game in one other way, through actions. An action has a name and a payload. The app validates the payload against a schema before the handler runs. The handler applies the action or refuses it with a typed error, and a refused action changes nothing. Here a player starts again once the game is over, and not before.

```ts title="rules.ts"
export class NotOver extends Schema.TaggedError<NotOver>()("NotOver", {}) {}

export const Restart = Action.define("catch/Restart", Schema.Void, {
  error: NotOver,
});

const restart = Action.handler(Restart, function* () {
  const basket = yield* Basket.writes;
  if (basket.lives > 0) {
    return yield* NotOver.make({});
  }
  basket.caught = 0;
  basket.lives = 3;
});
```

`Restart` carries nothing, so its payload is `Schema.Void`, and it is issued with none, `app.dispatch(Restart)`. An action with no payload and no refusal takes only its name, `Action.define("catch/Pause")`.

## Coins that keep coming

A coin falls every second. A system runs to the end of its tick and waits for nothing, so the time until the next coin is a number in the world that goes down on every tick. `Timer.every(1)` keeps it, and runs the system once per second of game time. Random numbers come from the seeded `Random` service, so the same seed always drops the same coins.

```ts title="rules.ts"
const Rain = System.tick("catch/Rain", function* () {
  const random = yield* Random;
  (yield* Commands.spawns(Position, Fall)).spawn(
    Position.of({ x: random.range(-4, 4), y: 10 }),
    Fall.of({ speed: random.range(2, 5) })
  );
}).pipe(Timer.every(1));
```

Game time only advances as the game ticks. The time left to the next coin is a singleton of the world, so a save holds it, and a replay counts it down the same way. [Timers](guides/timers.md) covers cooldowns and lifetimes too.

## The plugin

```ts title="rules.ts"
export const Rules = Plugin.make("catch/Rules", {
  plugins: [Input.controls("catch/Controls", [Move])],
  systems: [Steer, Drop, Land, Rain],
  handlers: [restart],
});
```

Systems run in the order they are listed. `Input.controls` declares the game's controls: a game that reads one it doesn't declare doesn't compile.

## Test it

A test creates an app and steps it by hand, one tick at a time, to play the game under Node, without a page. `App.define` says what the game is, and `App.make` starts one run of it. A test sets the scene with a plugin of its own, whose `setup` runs when the app is made. It reads the game with `app.read`.

Each method of an app returns an Effect, so a test is an Effect too: `it.effect` from `@effect/vitest` runs it, and the test yields each step with `yield*`.

```ts title="rules.test.ts"
import { expect, it } from "@effect/vitest";
import { App, Commands, Plugin, Replay, Test, World } from "arcadekit";
import { Effect, Exit } from "effect";

import { Basket, Fall, Position, Restart, Rules } from "./rules.ts";

const Catch = App.define({ plugins: [Rules] });

/** A coin just above the basket. */
const OneCoin = Plugin.make("catch/OneCoin", {
  setup: Effect.gen(function* () {
    (yield* Commands.spawns(Position, Fall)).spawn(
      Position.of({ x: 0, y: 0.5 }),
      Fall.of({ speed: 1 })
    );
  }),
});

/** No lives left. */
const Over = Plugin.make("catch/Over", {
  setup: Effect.gen(function* () {
    (yield* Basket.writes).lives = 0;
  }),
});

it.effect("catches a coin that lands in the basket", () =>
  Effect.gen(function* () {
    const app = yield* App.make(App.define({ plugins: [Rules, OneCoin] }));
    for (let i = 0; i < 60; i++) {
      yield* app.tick(1 / 60);
    }
    expect((yield* app.read(Basket)).caught).toBe(1);
  })
);

it.effect("refuses a restart while the game goes on", () =>
  Effect.gen(function* () {
    const app = yield* App.make(Catch);
    const restarted = yield* Effect.exit(app.dispatch(Restart));
    expect(Exit.isFailure(restarted)).toBe(true);
    const over = yield* App.make(App.define({ plugins: [Rules, Over] }));
    yield* over.dispatch(Restart);
    expect((yield* over.read(Basket)).lives).toBe(3);
  })
);
```

`app.dispatch` applies an action immediately, and fails with the action's refusal: `Effect.exit` turns that into a value to look at. `app.enqueue` instead queues the action for the start of the next tick, as a real-time game needs. Code outside the game has no other way to change it, because `app.read` takes nothing that writes.

To steer, a test presses keys. `Test.make` makes the app with a keyboard, a pointer and gamepads that the test works by hand, `game.input`, and `game.step()` runs one frame of a driver: it reads the devices, runs a tick, and draws.

A game that changes only through its input, its actions, its systems and its seed can be replayed. The app logs everything that comes from outside the simulation, what the controls said among it. `Replay.record(app)` gives that log with the seed the game began with and how long each tick was. `Replay.verify` plays the recording in an app made from that seed, with no keyboard, and checks the world's hash along the way:

```ts title="rules.test.ts"
it.effect(
  "steers with a key held, and plays the same game again from its log",
  () =>
    Effect.gen(function* () {
      const game = yield* Test.make(Catch, { seed: 7 });
      game.input.press("ArrowRight");
      for (let i = 0; i < 30; i++) {
        yield* game.step();
      }
      expect((yield* game.app.read(Basket)).x).toBeCloseTo(3);
      game.input.release("ArrowRight");
      for (let i = 0; i < 270; i++) {
        yield* game.step();
      }

      const recording = yield* Replay.record(game.app);
      const again = yield* Replay.verify(recording, Catch);
      const hash = (app: App.Any) =>
        Effect.map(app.read(World), (world) => world.hash());
      expect(yield* hash(again)).toBe(yield* hash(game.app));
    })
);
```

Run `pnpm vitest run`, and the three tests pass.

If anything in the rules read the clock or called `Math.random`, the replay would fail with `Replay.Diverged` at the first hash check where the two worlds differ. The app takes a hash check every 60 ticks by default.

## Play it in a page

The page adds what the rules leave out: a key to start again, and rendering.

The rules steer with their control and need nothing of the page. The page adds a control of its own, for Enter, and an input-stage system, which runs before each tick, reads it, and issues the game's action. The action is logged like any other, so a replay needs no keyboard.

Drawing happens in the frame stage, between ticks, where the world is read-only. A frame system can read anything and change nothing, so drawing never affects the simulation.

```ts title="main.ts"
import { Action, App, Driver, Input, Plugin, Query, System } from "arcadekit";
import { Browser } from "arcadekit/browser";
import { Context, Effect, Layer } from "effect";

import { Basket, Fall, Position, Restart, Rules } from "./rules.ts";

const canvas = document.querySelector("canvas")!;

const Again = Input.button("catch/Again", ["Enter", Input.padButton(0, 9)]);

const Keys = System.input("catch/Keys", function* () {
  if ((yield* Again).pressed) {
    (yield* Action.Actions).enqueue(Restart);
  }
});

class Screen extends Context.Service<
  Screen,
  { readonly context: CanvasRenderingContext2D }
>()("catch/Screen") {
  static readonly layer = Layer.sync(Screen, () => ({
    context: canvas.getContext("2d")!,
  }));
}

const Coins = Query.all(Position, Fall);
const scale = 40;

const Draw = System.frame("catch/Draw", function* () {
  const { context } = yield* Screen;
  const basket = yield* Basket;
  context.clearRect(0, 0, canvas.width, canvas.height);
  const toX = (x: number) => canvas.width / 2 + x * scale;
  const toY = (y: number) => canvas.height - 20 - y * scale;
  (yield* Coins).each((position) => {
    context.fillRect(toX(position.x) - 4, toY(position.y) - 4, 8, 8);
  });
  context.fillRect(toX(basket.x) - scale / 2, toY(0), scale, 6);
  context.fillText(`${basket.caught} caught, ${basket.lives} left`, 10, 20);
});

const Game = Plugin.make("catch/Game", {
  plugins: [Rules, Input.controls("catch/Keys", [Again])],
  systems: [Keys, Draw],
});

Browser.runMain(
  Driver.run(App.define({ plugins: [Game] }), {
    seed: Date.now(),
    hz: 60,
  }).pipe(Effect.provide(Screen.layer)),
  { target: canvas, preventDefault: ["ArrowLeft", "ArrowRight"] }
);
```

An action enqueued from the input stage that its handler refuses changes nothing, so Enter does nothing while the game goes on. `Driver.run` creates the app and runs it at sixty ticks a second, drawing once per repaint, until the page closes. Then `Driver.run` closes the app. `Browser.runMain` starts the game in the page, with the page's keyboard, pointer and gamepads. The seed is picked at the entry point, so the rules themselves stay deterministic.

Serve `main.ts` with any bundler, such as [Vite](https://vite.dev), from a page with a `<canvas width="480" height="480">`. At that size the whole field fits on the canvas. Coins fall toward the basket, the arrow keys, A and D or a gamepad's stick move it, Enter starts again once the game is over, and the top-left corner counts the coins caught and the lives left.

## Where to go next

- [Entities and systems](concepts/entities-and-systems.md) and [ticks and frames](concepts/ticks-and-frames.md) explain the structure this walkthrough used.
- [Determinism](concepts/determinism.md) covers the rules your game follows so that replays, saves and online play work.
- The guides cover one task each: [drawing with Three.js](guides/drawing-with-three.md), [sound](guides/sound.md), [a UI](guides/ui.md), [saving](guides/saving-and-loading.md), [several players](guides/sessions.md).
- [`examples/page`](../../../../examples/page) is a fuller game in a page, with assets, sound, music, and a UI built two ways.
