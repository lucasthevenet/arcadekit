---
title: "Making a game"
description: "Build a small game from scratch: coins fall, a basket catches them, and three missed coins end the game. You run it in a test first, then in a page."
---

In this walkthrough you build a small game from scratch: coins fall, a basket catches them, and three missed coins end the game. You run it in a test first, then in a page.

Along the way you use most of arcadekit: components, a singleton, systems, an action and its refusal, an event, a plugin, a replay, input, and a frame stage that draws. Each has its own guide, linked at the end.

## Install

```sh
pnpm add arcadekit effect @effect/platform-browser
pnpm add -D vitest
```

arcadekit is built on [Effect](https://effect.website) 4. `@effect/platform-browser` runs your game in a page. Running under Node, in a test or on a server, needs nothing more.

## The rules

A game's rules are a plugin: its components, its systems, the actions a player can take, and what runs at startup.

Start with the data. A coin is an entity with a position and a falling speed. There is only one basket, so instead of an entity it is a singleton.

```ts title="rules.ts"
import {
  Action,
  Commands,
  Component,
  Event,
  Field,
  Plugin,
  Query,
  Random,
  Singleton,
  System,
  Time,
} from "arcadekit";
import { Data, Effect, Schema } from "effect";

export const Position = Component.define("catch/Position", {
  x: Field.f32,
  y: Field.f32,
});
export const Fall = Component.define("catch/Fall", { speed: Field.f32 });

export const Basket = Singleton.define(
  "catch/Basket",
  { x: Field.f32, dx: Field.i32, caught: Field.i32, lives: Field.i32 },
  { x: 0, dx: 0, caught: 0, lives: 3 }
);
```

A component's fields are stored as numbers in typed arrays. Its name, `"catch/Position"`, is its identity, and saves refer to it by that name.

Next come the systems. A system runs once per tick as one Effect, and loops over the entities its query matches with a plain function. It reads the time from `Time`, never from the system clock.

```ts title="rules.ts"
const BASKET_WIDTH = 1;
const BASKET_SPEED = 6;

const Coins = Query.all(Position, Fall).pipe(Query.writes(Position));

const Steer = System.make("catch/Steer", function* () {
  const basket = yield* Basket;
  const { delta } = yield* Time;
  basket.x += basket.dx * BASKET_SPEED * delta;
});

const Drop = System.make("catch/Drop", function* () {
  const { delta } = yield* Time;
  (yield* Coins).each((position, fall) => {
    position.y -= fall.speed * delta;
  });
});
```

When a coin reaches the ground, it is either caught or missed, and despawned in both cases. You despawn an entity through `Commands`, which applies the change after the system finishes, so the world never changes under a running loop.

```ts title="rules.ts"
export const Caught = Event.define(
  "catch/Caught",
  Schema.Struct({ total: Schema.Int })
);

const Land = System.make("catch/Land", function* () {
  const basket = yield* Basket;
  const commands = yield* Commands;
  const caught = yield* Caught;
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

`Caught` is an event: a record that something happened, for any system that wants to react. The rules don't play sounds themselves; the sound plugin reads this event later.

## What a player can do

Players change the game only through actions. An action has a name and a payload, which is validated against a schema before its handler runs: here, a direction of -1, 0 or 1. The handler either applies the action or refuses it with a typed error, and a refused action changes nothing.

```ts title="rules.ts"
export const Move = Action.define(
  "catch/Move",
  Schema.Struct({
    dx: Schema.Int.check(Schema.isBetween({ minimum: -1, maximum: 1 })),
  })
);

export class GameOver extends Data.TaggedError("GameOver")<{}> {}

const move = Action.handler(Move, function* ({ dx }) {
  const basket = yield* Basket;
  if (basket.lives === 0) {
    return yield* new GameOver();
  }
  basket.dx = dx;
});
```

## Coins that keep coming

A coin falls every second. A system runs to the end of its tick and waits for nothing, so the time until the next coin is kept in the world, in a singleton, and a system counts it down. Random numbers come from the seeded `Random` service, so the same seed always drops the same coins.

```ts title="rules.ts"
const Cloud = Singleton.define("catch/Cloud", { wait: Field.f32 }, { wait: 0 });

const Rain = System.make("catch/Rain", function* () {
  const cloud = yield* Cloud;
  cloud.wait -= (yield* Time).delta;
  if (cloud.wait > 0) {
    return;
  }
  cloud.wait += 1;
  const random = yield* Random;
  (yield* Commands).spawn(
    Position.of({ x: random.next() * 8 - 4, y: 10 }),
    Fall.of({ speed: 2 + random.next() * 3 })
  );
});
```

The wait is one second of game time, which only advances as the game ticks. Because it is in the world, a save holds it, and a replay counts it down the same way.

## The plugin

```ts title="rules.ts"
export const Rules = Plugin.make("catch/Rules", {
  systems: [Steer, Drop, Land, Rain],
  handlers: [move],
});
```

Systems run in the order they are listed.

## Test it

You can create an app and step it by hand, one tick at a time. That is how a test plays a game under Node, without a page. `App.define` says what the game is, and `App.make` starts one run of it.

```ts title="rules.test.ts"
import { App, Journal } from "arcadekit";
import { Effect, Exit } from "effect";
import type { Scope } from "effect";
import { expect, it } from "vitest";

import { Basket, Fall, Move, Position, Rules } from "./rules";

const Catch = App.define({ plugins: [Rules] });

const play = <A>(body: Effect.Effect<A, unknown, Scope.Scope>) =>
  Effect.runSync(Effect.scoped(body));

it("catches a coin that lands in the basket", () =>
  play(
    Effect.gen(function* () {
      const app = yield* App.make(Catch);
      app.world.spawn(Position.of({ x: 0, y: 0.5 }), Fall.of({ speed: 1 }));
      for (let i = 0; i < 60; i++) {
        app.tick(1 / 60);
      }
      expect(app.world.singleton(Basket).caught).toBe(1);
    })
  ));

it("refuses a move once the game is over", () =>
  play(
    Effect.gen(function* () {
      const app = yield* App.make(Catch);
      app.world.singleton(Basket).lives = 0;
      const moved = app.dispatch(Move, { dx: 1 });
      expect(Exit.isFailure(moved)).toBe(true);
    })
  ));
```

`app.dispatch` applies an action immediately and returns its outcome. `app.enqueue` queues the action for the start of the next tick instead, which is what a real-time game needs.

A game that changes only through its actions, its systems and its seed can be replayed. The app logs every action from outside the simulation, `app.record()` returns that log with how long each tick was, and `Journal.replay` plays the recording into a new app, verifying the world's hash along the way:

```ts title="rules.test.ts"
it("plays the same game again from its log", () =>
  play(
    Effect.gen(function* () {
      const game = yield* App.make(Catch, { seed: 7 });
      game.enqueue(Move, { dx: 1 });
      for (let i = 0; i < 300; i++) {
        game.tick(1 / 60);
      }

      const again = yield* App.make(Catch, { seed: 7 });
      Journal.replay(again, game.record());
      expect(again.world.hash()).toBe(game.world.hash());
    })
  ));
```

If anything in the rules read the clock or called `Math.random`, the replay would stop at the first tick where the two worlds differ, with `Journal.ReplayDiverged`.

## Play it in a page

The page adds what the rules leave out: keyboard input and rendering.

Keys become actions. `Input.bind` creates an input-stage system, which runs before each tick and issues your game's actions. They are logged like any other action, so a replay needs no keyboard.

Drawing happens in the frame stage, between ticks, where the world is read-only. A frame system can read anything and change nothing, so drawing never affects the simulation.

```ts title="main.ts"
import { App, Driver, Input, Plugin, Query, System } from "arcadekit";
import * as Browser from "arcadekit/Browser";
import { Context, Effect, Layer } from "effect";

import { Basket, Fall, Move, Position, Rules } from "./rules";

const canvas = document.querySelector("canvas")!;

const Controls = Input.bind(
  "catch/Controls",
  Input.onPress("ArrowLeft", Move, { dx: -1 }),
  Input.onPress("ArrowRight", Move, { dx: 1 }),
  Input.onRelease(["ArrowLeft", "ArrowRight"], Move, { dx: 0 })
);

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

const Draw = System.make("catch/Draw", function* () {
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
}).pipe(System.inStage("frame"));

const Game = Plugin.make("catch/Game", {
  plugins: [Rules],
  systems: [Controls, Draw],
});

Browser.runMain(
  Driver.run(App.make(App.define({ plugins: [Game] }), { seed: Date.now() }), {
    hz: 60,
  }).pipe(Effect.provide(Screen.layer)),
  { target: canvas, preventDefault: ["ArrowLeft", "ArrowRight"] }
);
```

`App.make` creates the app, and `Driver.run` runs it at sixty ticks a second, drawing once per repaint, until the page closes. `Browser.runMain` starts it in the page, with the page's keyboard, pointer and gamepads. The seed is picked at the entry point, so the rules themselves stay deterministic.

Serve `main.ts` with any bundler, such as [Vite](https://vite.dev), from a page with a `<canvas>`.

## Where to go next

- [Entities and systems](concepts/entities-and-systems.md) and [ticks and frames](concepts/ticks-and-frames.md) explain the structure this walkthrough used.
- [Determinism](concepts/determinism.md) covers the rules your game follows so that replays, saves and online play work.
- The guides cover one task each: [drawing with Three.js](guides/drawing-with-three.md), [sound](guides/sound.md), [a UI](guides/ui.md), [saving](guides/saving-and-loading.md), [several players](guides/lockstep-and-rollback.md).
- [`examples/page`](../../../../packages/arcadekit/examples/page) is a fuller game in a page, with assets, sound, music, and a UI built two ways.
