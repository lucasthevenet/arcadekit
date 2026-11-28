---
title: "Devices and the input stage"
description: "Below a game's controls are the keyboard, the pointer and the gamepads, read by their codes. The input stage reads them once before each tick, and a game's own input systems issue actions from them."
---

The **devices** are the keyboard, the pointer, and the gamepads, below the [controls](input.md) a game declares. The **input stage** reads them just before each tick: it works out what the controls say, and runs the game's input systems, which issue actions of their own.

## Read the devices by their codes

`Input.plugin`, which `Input.controls` installs, provides `Input.Keyboard`, `Input.Pointer`, and `Input.Gamepads`, each read with `yield*`, a gamepad by its index: `(yield* Input.Gamepads)(0)`. They are the level below the controls, for what reads a device by its code, such as a debug key, and for the pointer's position:

```ts
import { Input, System } from "arcadekit";

const Aim = System.tick("game/Aim", function* () {
  const pointer = yield* Input.Pointer;
  const keys = yield* Input.Keyboard;
  const aim = { x: pointer.x, y: pointer.y };
  const debug = keys.pressed("F3");
});
```

- `Input.Keyboard` has `down`, `pressed`, and `released`. `Input.Pointer` has `x`, `y`, and the same three for a button, the primary button by default. A gamepad of `Input.Gamepads` has `axis(n)` and the same three for a button. Each stage reads them as it reads a control.
- A game that reads them and leaves out the plugin doesn't compile.

## Write an input system of your own

An input-stage system reads the controls, the devices, and the world, and issues any action. Picking the card under the pointer needs all three:

```ts
import {
  Action,
  Component,
  EntityId,
  Field,
  Input,
  Query,
  System,
} from "arcadekit";
import { Schema } from "effect";

const Card = Component.define("game/Card", {
  left: Field.f32,
  right: Field.f32,
});
const Cards = Query.all(Card);
const PlayCard = Action.define(
  "game/PlayCard",
  Schema.Struct({ card: EntityId })
);
const Pick = Input.button("game/Pick", [Input.pointerButton()]);

const Picking = System.input("game/Picking", function* () {
  if (!(yield* Input.Read(Pick)).pressed) {
    return;
  }
  const { x } = yield* Input.Pointer;
  const actions = yield* Action.Actions;
  (yield* Query.View(Cards)).each((card, entity) => {
    if (card.left <= x && x < card.right) {
      actions.enqueue(PlayCard, { card: entity });
    }
  });
});
```

- A control and the devices are read from the stage's sample, the same for every system of the stage, with the app's bindings. An action issued here is logged, and applied at the start of the next tick. The game declares `Pick` with `Input.controls`.
- `Input.Devices` is the sample itself: the buttons that are `down`, the buttons `pressed` and `released` since the previous sample, the `axes`, and the axes that `moved`. It isn't part of the game, so a system of the tick or the frame stage can't require it. A game of several players reads it, or its controls, and issues actions that carry the player.

## Run the input stage

A driver runs the input stage just before each tick. A tick doesn't read the devices, so a game that steps its app by hand runs `yield* app.input()` before each `yield* app.tick(delta)` that should receive them.

- The stage reads the devices once per run. A frame with no tick due reads nothing, and the presses in between wait for the next tick, so a quick tap between two frames is never lost.
- The world is read-only here, as in the frame stage. A system issues actions with `Actions.enqueue` and changes nothing itself. The app logs the actions and applies them at the start of the next tick.
- The stage reads events through its own reader, each event once. It receives what a tick's systems emitted, what its actions emitted, and `Action.Rejected`, so a system that issued an action learns that it was refused. When the stage doesn't run at all, the app keeps its events for up to 600 ticks.
- A replay doesn't run the stage, because the log already holds what the devices and the controls reported. A tool that re-runs a game from its log ticks it with `app.tick(delta)` alone. See [replays](replays.md).

The simulation can't tell whether its devices are read. A game played from a keyboard and its replay have the same hash at every tick.

## Choose where device input comes from

`Input.Source` is where device input comes from. By default there is none, which suits a replay, a server, and most tests.

- Having no devices differs from having devices with nothing pressed. With no source, the state stays as last reported. A game fed its reports from a log or from another machine can therefore run under a driver, input stage included, and plays out the same way.
- In a page, `Browser.runMain` provides the page's keyboard, pointer, and gamepads. The pointer is a mouse, a pen, or a finger. `Browser.layer(options)` provides the same devices to a program that starts itself. [Run a game in a page](running-a-game.md#run-a-game-in-a-page) lists the options.
- A held key goes down once, and everything held is released when the page loses focus. Mouse buttons held together are tracked one by one. A key whose code isn't one of `Input.KeyCode` isn't heard. The first time a code comes that the list doesn't have, Effect's logger warns of it, once for each code, since a browser can send one the specification doesn't list yet. A key with no code, or the code `"Unidentified"`, is no key and isn't warned of.
- `App.make` listens to the devices in the app's own scope, and stops when the app is closed. The devices are heard for as long as the app is open, wherever `Browser.layer` is provided. Each app listens for itself. Reading the devices after the app is closed throws an error that says so.
- A test, a tool, or on-screen controls use `Input.makeManualSource()`, or `Test.make`, which makes the game with one. Drive it by hand with `press`, `release`, `tap`, and `move`. See [testing](testing.md).

What reading the devices costs a tick is in [performance](performance.md#idle-ticks-and-frames).

## Read more

- [Input](input.md), for the controls a game declares and reads.
- [`Input`](/reference/arcadekit/Input) and [`Browser`](/reference/arcadekit/browser/Browser) in the API reference.
- [Ticks and frames](../concepts/ticks-and-frames.md), for the three stages.
