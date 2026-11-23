---
title: "A UI"
description: "Build menus and HUDs with any UI library: the page's DOM, React, anything else. A bridge connects them to your game: the game publishes views, and the UI sends actions."
---

Build your game's menus and heads-up display with any UI library you like: the page's own DOM, React, or anything else. arcadekit depends on none of them. Instead it provides a **bridge**: the game publishes the values the UI may see, and the UI acts by sending actions.

## The protocol

Put the views and actions the UI and the game share in one module. It is the only part of the game the UI imports.

```ts title="protocol.ts"
import { Action, View } from "arcadekit";
import { Schema } from "effect";

export const Hud = View.define("game/Hud", { score: 0, lives: 3 });
export const NewGame = Action.define("game/NewGame", Schema.Struct({}));
```

A **view** has a name and an initial value, which the UI sees until the game first publishes, and which determines its type. Its value is plain data: strings, numbers, booleans, and arrays and objects of them.

Like an action, a view is a key and not part of the game. The game never reads a view: it is what the UI sees, not game state.

## Publishing views

`View.publish` creates a frame-stage system. Each frame it computes the value, and publishes it only if it differs from what the UI has.

```ts title="game.ts"
import { Field, Plugin, Singleton, View, Action } from "arcadekit";

import { Hud, NewGame } from "./protocol";

const Score = Singleton.define(
  "game/Score",
  { points: Field.i32, lives: Field.i32 },
  { points: 0, lives: 3 }
);

const ShowHud = View.publish(Hud, function* () {
  const score = yield* Score;
  return { score: score.points, lives: score.lives };
});

const newGame = Action.handler(NewGame, function* () {
  const score = yield* Score.writes;
  score.points = 0;
  score.lives = 3;
});

export const Game = Plugin.make("game/Game", {
  plugins: [View.plugin],
  systems: [ShowHud],
  handlers: [newGame],
});
```

Values are compared structurally, field by field, at any depth. The body can return a new object every frame, and the UI is only notified when something in it changed: an unchanged value costs the UI nothing, not even a call.

- The body can read anything a frame system can: singletons, states, queries, events, assets. It can't change the game.
- Several ticks within one frame produce one publication, of the latest value.
- When no UI is attached, on a server, in a replay, or in most tests, no body runs at all.
- The whole value is computed and compared every frame while a UI is attached. Gate a view that is costly to compute with `System.runIf`.
- A frame system of your own publishes through `(yield* View.Port).publish(view, value)`, which reports whether the value was new. A system of the tick or the input stage cannot require `View.Port`.

## The UI holds the bridge

A UI never holds the app. It receives a `View.Bridge`, and nothing else from the game.

```ts title="ui.ts"
import type { View } from "arcadekit";

import { Hud, NewGame } from "./protocol";

export const mount = (root: Element, ui: View.Bridge) => {
  const label = root.querySelector("output")!;
  label.textContent = `${ui.get(Hud).score}`;
  ui.subscribe(Hud, ({ score }) => {
    label.textContent = `${score}`;
  });
  root.querySelector("button")!.onclick = () => ui.send(NewGame, {});
};
```

- `ui.get(view)` returns the last published value, the same object until it changes, so `===` tells a UI library whether anything changed.
- `ui.subscribe(view, listener)` calls the listener each time the value changes, and returns a function that unsubscribes. It isn't called with the current value: read that with `get`. A listener that throws fails the frame, like any bug in the frame stage, after every other listener has been notified.
- `ui.send(action, payload)` requests an action. `View.plugin` issues it in the input stage, before the next tick: it is logged, and applied or refused by its handler, exactly as a key bound to it would be. A replay therefore needs no UI, and a button is as good as a key.

Sending an action the game has no handler for is a bug, and `send` throws in the UI's own code: `View.plugin` tells the bridge which actions the game handles, from when the app is created until it ends. An action sent before the game exists, when this can't be checked, throws in the game's first input stage.

The UI isn't told the outcome of an action it sent. A refusal is an `Action.Rejected` event, which a frame system can read and publish as a view. `ui.send` accepts any action as far as the compiler knows; whether the game handles it is checked at run time.

A bridge refuses two different views with the same name.

## Connecting them at the entry point

```ts title="main.ts"
import { App, Driver, View } from "arcadekit";
import * as Browser from "arcadekit/Browser";
import { Effect } from "effect";

import { Game } from "./game";
import { mount } from "./ui";

const ui = View.makeBridge();
mount(document.body, ui);

Browser.runMain(
  Driver.run(App.make(App.define({ plugins: [Game] })), { hz: 60 }).pipe(
    Effect.provide(View.layer(ui))
  ),
  { target: document.querySelector("canvas")! }
);
```

You can mount a UI before the game is created: it sees every view at its initial value, and what it sends waits.

What the UI sends is applied by the next tick, which under a driver is in the frame it was sent or the one after. A game that steps its app by hand runs a tick itself when its UI has sent something.

`View.Bridge` is a `Context.Reference` whose default is no UI, which is what a server, a replay and most tests have. Given the same actions, a game with a UI and the same game without one have the same hash, log and save.

## With React

Connecting the bridge to a UI library takes a few lines in your game:

```ts sketch
const useView = <A>(ui: View.Bridge, view: View.View<A>): A =>
  useSyncExternalStore(
    (changed) => ui.subscribe(view, changed),
    () => ui.get(view)
  );
```

## A UI for part of the game

`View.publish` accepts `System.runIf` like any system. A view that isn't published keeps its last value, which suits a costly view computed only now and then. A view that belongs to one part of the game, and shouldn't be visible elsewhere, returns to its initial value while its system doesn't run:

```ts title="game.ts"
import { State, System } from "arcadekit";

const Phase = State.define("game/Phase", ["menu", "playing"]);

export const ShowHudWhilePlaying = ShowHud.pipe(
  System.runIf(State.is(Phase, "playing")),
  System.otherwise(View.reset(Hud))
);
```

## With rollback

In a multiplayer game played with [rollback](sessions.md), a tick can run again. The frame stage hears its events once, but what it showed of the prediction was shown: the UI can be shown a score that is then rolled back. A view that must only show final results checks the session's `session.confirmed`.

## Read more

- [`View`](/reference/arcadekit/View) in the API reference.
- [`examples/page`](../../../../../packages/arcadekit/examples/page) builds its menu and HUD twice on one bridge, with the DOM (`uiDom.ts`) and with React (`uiReact.ts`, shown with `?ui=react`). Neither imports anything from the game except `protocol.ts`.
- [Testing](testing.md#a-ui) a game through its bridge.
