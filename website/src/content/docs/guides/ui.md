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

A view has a name and the value the UI sees until the game first says otherwise, which gives it its type. Its value is plain data: text, numbers, booleans, and arrays and objects of them.

A view is a key and nothing of the game, like an action. The game never reads one: it is what the UI sees, not state.

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

Two values are compared as data, field by field and however deep. So the body returns a new object each frame, and the UI is told only when something in it changed: a value that did not change costs the UI nothing, not a call.

- The body reads what a frame system can: singletons, states, queries, events, assets. It cannot change the game.
- Several ticks and one frame are one publication, of the latest value.
- Where no UI is there, on a server, in a replay, in most tests, no body runs at all.
- A frame system of the game's own publishes through `(yield* View.Port).publish(view, value)`, which says whether the value was news. In a tick, publishing throws.

## The UI holds the bridge

A UI does not hold the app. It is handed a `View.Bridge`, and nothing else of the game.

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
- `ui.subscribe(view, listener)` calls the listener each time it changes, and returns what stops it. It is not called with the value the view has now: read that with `get`. A listener that throws fails the frame, as any bug in the frame stage does, once every other listener was told.
- `ui.send(action, payload)` asks the game for an action. `View.plugin` issues it in the input stage, before the next tick: logged, and applied or refused by its handler, exactly as a key bound to it would be. So a replay needs no UI, and a button is as good as a key.

An action the game has no handler for is a bug, and `send` throws for it there, in the UI's own code: `View.plugin` tells the bridge which actions the game handles when the app is made, and until the app ends. One sent before the game is made, when nobody can tell, throws in the game's first input stage.

A bridge refuses two different views with one name.

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

`View.Bridge` is a `Context.Reference` whose default is no UI, which is what a server, a replay and most tests have. A game with a UI and the same game with none have the same hash, log and save, given the same actions.

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

`View.publish` takes `System.runIf` like any system. A view that is not published keeps the value it had, which is what a view that is costly to work out, and is worked out now and then, wants. One that belongs to a part of the game, and should not be seen when the game is elsewhere, goes back to its initial value while its system does not run:

```ts title="game.ts"
import { State, System } from "arcadekit";

// Listed in a plugin's components, as Score is.
const Phase = State.define("game/Phase", ["menu", "playing"]);

export const ShowHudWhilePlaying = ShowHud.pipe(
  System.runIf(State.is(Phase, "playing")),
  System.otherwise(View.reset(Hud))
);
```

## With rollback

In a game of several peers played with [rollback](lockstep-and-rollback.md), a tick can be run again, and what the frame stage did for it is done again: a UI is told of a score that is then taken back. The frame stage is not told which ticks are final. A view that must show only what is final asks the session, `session.confirmed`.

## Read more

- [`View`](/reference/arcadekit/View) in the API reference.
- [`examples/page`](../../../../../packages/arcadekit/examples/page) builds its menu and heads-up display twice on one bridge, with the DOM (`ui-dom.ts`) and with React (`ui-react.ts`, shown by `?ui=react`). Neither imports anything of the game but `protocol.ts`.
- [Testing](testing.md#a-ui) a game through its bridge.
