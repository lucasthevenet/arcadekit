---
title: "A UI"
description: "A game's menus and heads-up display are built with whatever the game chooses: the page's own DOM, React, anything. arcadekit depends on none of them."
---

A game's menus and heads-up display are built with whatever the game chooses: the page's own DOM, React, anything. arcadekit depends on none of them. What it gives is a bridge: the game says which values the UI may see, and the UI acts by sending actions.

## The protocol

The views and actions the UI and the game share go in one module. It is the only thing of the game the UI imports.

```ts title="protocol.ts"
import { Action, View } from "arcadekit";
import { Schema } from "effect";

export const Hud = View.define("game/Hud", { score: 0, lives: 3 });
export const NewGame = Action.define("game/NewGame", Schema.Struct({}));
```

A view has a name and the value the UI sees until the game first says otherwise, which gives it its type. Its value is plain data.

## The game publishes

`View.publish` makes a system of the frame stage. Each frame it works the value out, and publishes it only if it differs from what the UI has.

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
  const score = yield* Score;
  score.points = 0;
  score.lives = 3;
});

export const Game = Plugin.make("game/Game", {
  plugins: [View.plugin],
  components: [Score],
  systems: [ShowHud],
  handlers: [newGame],
});
```

Two values are compared as data, field by field. So the body returns a new object each frame, and the UI is told only when something in it changed. Where no UI is there, on a server or in a replay, no body runs at all.

## The UI holds the bridge

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

- `ui.get(view)` is the value as last published, the same object until it changes, so `===` tells a UI library whether anything did.
- `ui.subscribe(view, listener)` is called each time it changes, and returns what stops it.
- `ui.send(action, payload)` asks the game for an action. It is issued in the input stage, logged, and applied or refused by its handler, exactly as a key bound to it would be. A replay needs no UI.

## The entry point joins them

```ts title="main.ts"
import { App, View } from "arcadekit";
import * as Browser from "arcadekit/Browser";
import { Effect } from "effect";

import { Game } from "./game";
import { mount } from "./ui";

const ui = View.makeBridge();
mount(document.body, ui);

Browser.runMain(
  App.run({ plugins: [Game] }, { hz: 60 }).pipe(Effect.provide(View.layer(ui))),
  { target: document.querySelector("canvas")! }
);
```

A UI can be mounted before the game is made: it sees every view at its initial value, and what it sends waits.

## With React

Binding the bridge to a UI library is a few lines in the game:

```ts sketch
const useView = <A>(ui: View.Bridge, view: View.View<A>): A =>
  useSyncExternalStore(
    (changed) => ui.subscribe(view, changed),
    () => ui.get(view)
  );
```

## A UI for part of the game

`View.publish` takes `System.runIf` like any system. A view that belongs to one part of the game goes back to its initial value while the game is elsewhere with `System.otherwise(View.reset(Hud))`.

## Read more

- [The view bridge](/reference/arcadekit#the-view-bridge) in the reference.
- [`examples/page`](../../../../../packages/arcadekit/examples/page) builds its menu and heads-up display twice on one bridge, with the DOM and with React.
