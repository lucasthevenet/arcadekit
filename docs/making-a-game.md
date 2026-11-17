# Making a game

This page builds a small game from nothing: coins fall, a basket catches them, and three missed coins end the game. It runs in a test first, then in a page.

Along the way it uses most of what arcadekit has: components, a singleton, systems, an action and its refusal, an event, a script, a plugin, a replay, input, and a frame stage that draws. Each has a guide of its own, linked at the end.

## Install

```sh
pnpm add arcadekit effect @effect/platform-browser
pnpm add -D vitest
```

arcadekit is built on [Effect](https://effect.website) 4. `@effect/platform-browser` is what runs a game in a page. A game that also runs under Node, as a test or a server does, needs nothing more.

## The rules

A game's rules are a plugin: its components, its systems, the actions a player may take, and what runs at the start.

Start with the data. A coin is an entity with a place and a speed. The basket is not an entity: there is one, so it is a singleton.

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
  Script,
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

A component's fields are numbers in typed arrays. A component's name, `"catch/Position"`, is its identity: it is how a save names it.

Now the systems. A system runs once per tick, as one Effect, and loops over what its query finds with a plain function. It reads the time from `Time`, never from the clock.

```ts title="rules.ts"
const BASKET_WIDTH = 1;
const BASKET_SPEED = 6;

const Coins = Query.all(Position, Fall).pipe(Query.reads(Fall));

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

When a coin reaches the ground, it is caught or missed. Either way it goes. An entity is despawned through `Commands`, which applies the change once the system is done, so the loop never sees the world change under it.

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

`Caught` is an event: what the rules say happened, for whoever wants to know. The rules don't play a sound. What the game sounds like reads this event later.

## What a player can do

A player changes the game only through actions. An action has a name and a payload, checked against a schema before its handler runs: here, a direction of -1, 0 or 1. The handler applies it or refuses it with a typed error. A refused action changes nothing.

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
    return yield* Effect.fail(new GameOver());
  }
  basket.dx = dx;
});
```

## Coins that keep coming

A script is code that runs across many ticks. This one drops a coin every second, somewhere random. Random numbers come from `Random`, which is seeded, so the same seed drops the same coins.

```ts title="rules.ts"
const Rain = Effect.gen(function* () {
  const script = yield* Script;
  const commands = yield* Commands;
  const random = yield* Random;
  while (true) {
    commands.spawn(
      Position.of({ x: random.next() * 8 - 4, y: 10 }),
      Fall.of({ speed: 2 + random.next() * 3 })
    );
    yield* script.sleep(1);
  }
});
```

`script.sleep(1)` waits one second of game time, which passes only as the game ticks.

## The plugin

```ts title="rules.ts"
export const Rules = Plugin.make("catch/Rules", {
  components: [Position, Fall, Basket],
  systems: [Steer, Drop, Land],
  handlers: [move],
  scripts: [Rain],
});
```

Systems run in the order they are listed. `components` lists what a save may name, so that one can be loaded.

## Test it

An app can be made and stepped by hand, one tick at a time. That is how a test plays a game, under Node, with no page.

```ts title="rules.test.ts"
import { App } from "arcadekit";
import { Effect, Exit } from "effect";
import type { Scope } from "effect";
import { expect, it } from "vitest";

import { Basket, Fall, Move, Position, Rules } from "./rules";

const play = <A>(body: Effect.Effect<A, unknown, Scope.Scope>) =>
  Effect.runSync(Effect.scoped(body));

it("catches a coin that lands in the basket", () =>
  play(
    Effect.gen(function* () {
      const app = yield* App.make({ plugins: [Rules] });
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
      const app = yield* App.make({ plugins: [Rules] });
      app.world.singleton(Basket).lives = 0;
      const moved = app.dispatch(Move, { dx: 1 });
      expect(Exit.isFailure(moved)).toBe(true);
    })
  ));
```

`app.dispatch` applies an action now and returns its outcome. `app.enqueue` is the other way: the action waits for the start of the next tick, which is what a game that runs in real time wants.

A game that changes only by its actions, its systems and its seed can be played again. The app logs every action that came from outside, and `App.replay` plays the log into a new app, checking the world's hash as it goes:

```ts title="rules.test.ts"
it("plays the same game again from its log", () =>
  play(
    Effect.gen(function* () {
      const game = yield* App.make({ plugins: [Rules], seed: 7 });
      game.enqueue(Move, { dx: 1 });
      for (let i = 0; i < 300; i++) {
        game.tick(1 / 60);
      }

      const again = yield* App.make({ plugins: [Rules], seed: 7 });
      App.replay(again, game.actionLog, { delta: 1 / 60, ticks: 300 });
      expect(again.world.hash()).toBe(game.world.hash());
    })
  ));
```

If anything in the rules read the clock or `Math.random`, the replay would stop at the first tick where the two worlds differ, with `App.ReplayDiverged`.

## Play it in a page

The page adds what the rules don't have: keys, and a picture.

Keys become actions. `Input.bind` makes a system of the input stage, which runs before each tick and issues the game's own actions. They are logged like any other, so a replay needs no keyboard.

Drawing happens in the frame stage, between ticks, with the world frozen. A system there reads what it likes and changes nothing, so a game that is drawn is the same game as one that is not.

```ts title="main.ts"
import { App, Input, Plugin, Query, System } from "arcadekit";
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

const Coins = Query.all(Position, Fall).pipe(Query.reads());
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
  App.run({ plugins: [Game], seed: Date.now() }, { hz: 60 }).pipe(
    Effect.provide(Screen.layer)
  ),
  { target: canvas, preventDefault: ["ArrowLeft", "ArrowRight"] }
);
```

`App.run` makes the app and runs it at sixty ticks a second, drawing once per repaint, until the page goes away. `Browser.runMain` starts it in the page, with the page's keyboard, pointer and gamepads. The seed comes from outside, at the entry point: the rules themselves stay repeatable.

Serve `main.ts` with any bundler, [Vite](https://vite.dev) for instance, from a page with a `<canvas>`.

## Where to go next

- [Entities and systems](concepts/entities-and-systems.md) and [ticks and frames](concepts/ticks-and-frames.md) explain the shape this page used.
- [Determinism](concepts/determinism.md) says what a game must not do for its replays, saves and network play to work.
- The guides go further, a task at a time: [drawing with Three.js](guides/drawing-with-three.md), [sound](guides/sound.md), [a UI](guides/ui.md), [saving](guides/saving-and-loading.md), [several players](guides/lockstep-and-rollback.md).
- [`examples/page`](../packages/arcadekit/examples/page) is a fuller game in a page, with assets, sound, music and a UI built two ways.
