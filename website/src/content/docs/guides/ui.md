---
title: "A UI"
description: "Build menus and HUDs with any UI library: the page's DOM, React, anything else. A bridge connects them to your game: the game publishes views, and the UI sends actions."
---

A **bridge** connects a game to its UI, the menus and the heads-up display. The game publishes the values that the UI may see, and the UI acts by sending actions. Build the UI with any library, such as the page's own DOM or React. arcadekit depends on none of them.

## Define the protocol

Put the views and actions that the UI and the game share in one module. The UI imports nothing else from the game.

```ts title="protocol.ts"
import { Action, View } from "arcadekit";
import { Schema } from "effect";

export const Hud = View.define("game/Hud", { score: 0, lives: 3 });
export const NewGame = Action.define("game/NewGame", Schema.Struct({}));
```

A **view** has a name and an initial value. The UI sees the initial value until the game first publishes, and the initial value sets the view's type. A view's value is plain data: strings, numbers, booleans, and arrays and objects of them.

Like an action, a view is a key and not part of the game. The game never reads a view, because a view is what the UI sees, not game state.

## Publish views

`View.publish` makes a frame-stage system. Each frame that the UI watches the view, it computes the value and publishes it only if it differs from what the UI has.

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

The system compares values field by field, at any depth. The body can return a new object every frame, and the UI is notified only when something in it changed. An unchanged value costs the UI nothing, not even a call.

- The body can read anything a frame system can: singletons, states, queries, events, and assets. It can't change the game.
- Several ticks within one frame produce one publication, of the latest value.
- The body runs only while the UI watches the view: while the view has a listener, and in the frame after the UI reads it with `get`. When no UI is attached, as on a server, in a replay, or in most tests, no body runs at all.
- While the UI watches a view, the system computes and compares the whole value every frame. For a view that is costly to compute, give `View.publish` a `when`, as [below](#compute-a-costly-view-only-when-its-inputs-change).
- A frame system of your own publishes through `(yield* View.Port).publish(view, value)`, which reports whether the value was new. It refuses a singleton read whole, as `View.publish` does. `(yield* View.Port).watched(view)` says whether the UI watches the view. A system of the tick or the input stage that requires `View.Port` doesn't compile.

## Read views and send actions from the UI

A UI never holds the app. The app hands it a `View.Bridge`, and nothing else of the game. The bridge's type names the actions that the UI sends.

```ts title="ui.ts"
import type { View } from "arcadekit";

import { Hud, NewGame } from "./protocol";

export const mount = (root: Element, ui: View.Bridge<typeof NewGame>) => {
  const label = root.querySelector("output")!;
  label.textContent = `${ui.get(Hud).score}`;
  const stop = ui.subscribe(Hud, ({ score }) => {
    label.textContent = `${score}`;
  });
  root.querySelector("button")!.onclick = () => ui.send(NewGame, {});
  return stop;
};
```

- `ui.get(view)` returns the last published value. It returns the same object until the value changes, so `===` tells a UI library whether anything changed. A view that the UI doesn't listen to is computed in the frame after `get` reads it, so `get` returns it a frame late.
- `ui.subscribe(view, listener)` calls the listener each time the value changes, and returns a function that unsubscribes. It doesn't call the listener with the current value, so read that with `get`. A listener that throws fails the frame, like any bug in the frame stage, once every other listener has been notified.
- `ui.send(action, payload)` requests an action. `View.plugin` issues it in the input stage, before the next tick. The app logs it, and its handler applies or refuses it, exactly as for a key bound to it. A replay therefore needs no UI, and a button counts the same as a key.

A bridge sends the actions of its type and no other. The app of a game hands out a bridge that sends every action the game has a handler for. A UI that takes a `View.Bridge<typeof NewGame>` can be handed the bridge only if the game handles `NewGame`. A `View.Bridge` with no actions reads views and sends nothing. An action that the game has no handler for doesn't compile, in `send` or where the bridge is handed to the UI.

The UI isn't told the outcome of an action it sent. A refusal is an event, which a frame system reads with `Action.rejected(action)`, typed, and publishes as a view. See [read the refusals of an action](events-and-actions.md#read-the-refusals-of-an-action).

A bridge refuses two different views with the same name.

## Connect the UI and the game at the entry point

```ts title="main.ts"
import { App, Driver, View } from "arcadekit";
import { Browser } from "arcadekit/browser";
import { Effect } from "effect";

import { Game } from "./game";
import { mount } from "./ui";

const Arcade = App.define({ plugins: [Game] });

const ui = View.mount(Arcade, (bridge) => mount(document.body, bridge));

Browser.runMain(Driver.run(Arcade, { hz: 60 }).pipe(Effect.provide(ui)), {
  target: document.querySelector("canvas")!,
});
```

`View.mount(game, mount)` gives the app a UI. When the app is made, `View.plugin` makes the bridge and calls `mount` with it. If `mount` returns a function, the app calls it when it closes, to take the UI off the page. Each app made under the layer hands out a bridge of its own. A game that doesn't list `View.plugin`, itself or through one of its plugins, doesn't compile here, since its app would hand out no bridge.

Give the layer and the app the same game. A layer provided to the app of another game hands out a bridge that can send an action the app has no handler for, and the app's input stage then throws.

The UI sees every view at its initial value until the first frame publishes it.

The next tick applies what the UI sends. Under a driver, that tick runs in the frame the action was sent in or the one after. A game that steps its app by hand runs a tick itself when its UI has sent something.

Without `View.mount` the app has no UI, which is what a server, a replay, and most tests have. Given the same actions, a game with a UI and the same game without one have the same hash, log, and save.

## Use the bridge from React

A few lines of your game connect the bridge to a UI library. A React hook:

```ts sketch
const useView = <A>(ui: View.Bridge, view: View.View<A>): A =>
  useSyncExternalStore(
    (changed) => ui.subscribe(view, changed),
    () => ui.get(view)
  );
```

## Compute a costly view only when its inputs change

Give `View.publish` a `when` before the body. `when` reads the few cheap values the view is computed from, such as a state or a singleton, and returns them. The body runs again only when they differ from what they were the last time it ran, compared as data:

```ts title="game.ts"
const Rank = View.define("game/Rank", { title: "novice" });

export const ShowRank = View.publish(
  Rank,
  {
    when: function* () {
      return (yield* Score).points;
    },
  },
  function* () {
    const { points } = yield* Score;
    return { title: points >= 1000 ? "master" : "novice" };
  }
);
```

The body runs again only when what `when` returns changes. Anything else it reads shows as it was when the body last ran. `when` and the body return data, such as `(yield* Score).points` or `{ ...(yield* Score) }`. A singleton read whole, `yield* Score` or `(yield* World).singleton(Score)`, doesn't compile as either, even inside arrays and objects up to 32 levels deep: it is the world's own object, the same every frame, so it would never differ.

## Show a view in one part of the game

`View.publish` accepts `System.runIf` like any system. A view that isn't published keeps its last value. For a view that belongs to one part of the game and shouldn't show elsewhere, give `View.reset` to `System.otherwise`. The view returns to its initial value while its system doesn't run:

```ts title="game.ts"
import { State, System } from "arcadekit";

const Phase = State.define("game/Phase", ["menu", "playing"]);

export const ShowHudWhilePlaying = ShowHud.pipe(
  System.runIf(State.is(Phase, "playing")),
  System.otherwise(View.reset(Hud))
);
```

## Show views under rollback

In a multiplayer game played with [rollback](sessions.md), a tick can run again. The frame stage hears its events once, but it has already shown what it showed of the prediction. The UI can show a score that is later rolled back. A view that must show only final results checks `session.confirmed`.

## Read more

- [`View`](/reference/arcadekit/View) in the API reference.
- [`examples/page`](../../../../../packages/arcadekit/examples/page) builds its menu and HUD twice on one bridge, with the DOM (`uiDom.ts`) and with React (`uiReact.ts`, shown with `?ui=react`). Neither imports anything from the game except `protocol.ts`.
- [Testing](testing.md#act-as-the-ui) a game through its bridge.
