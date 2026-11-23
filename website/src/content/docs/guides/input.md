---
title: "Input"
description: "Keyboard, pointer and gamepad input reaches your game as actions, through the same log as all outside input, so replays need no devices."
---

**Input** is what the keyboard, the pointer, and the gamepads report. It reaches the game as actions, through the same log as every other input from outside the game, so a replay needs no devices. A game reads input with bindings, from the device state, or both.

## Bind devices to actions

`Input.bind` maps the devices to your game's own actions. It makes an input-stage system, which runs before each tick:

```ts
import { Action, Input, Plugin } from "arcadekit";
import { Schema } from "effect";

const Fire = Action.define("game/Fire", Schema.Struct({ x: Schema.Finite }));
const TogglePause = Action.define("game/TogglePause", Schema.Struct({}));

const fire = Action.handler(Fire, function* ({ x }) {});
const togglePause = Action.handler(TogglePause, function* () {});

const Controls = Input.bind(
  "game/Controls",
  Input.onPress(["KeyP", Input.padButton(0, 9)], TogglePause, {}),
  Input.onPress(Input.pointerButton(), Fire, (devices) => ({
    x: devices.axes.get(Input.pointerX) ?? 0,
  }))
);

const Game = Plugin.make("game/Game", {
  systems: [Controls],
  handlers: [fire, togglePause],
});
```

- `Input.onPress` issues an action when one of its codes is pressed, `Input.onRelease` when one is released, and `Input.onMove` when one moves. Given several codes, a binding issues its action once when any of them fires.
- The payload is a value, or a function of the devices for an action that needs the pointer's position. The compiler checks the payload against the action.
- Handlers know nothing about keys. You can change the keys without changing the game or its replays. The log records `Fire`, not the button that issued it.
- `Input.bind` fixes the bindings when it makes the system. To let players choose their keys, [write an input system](#write-an-input-system-of-your-own) that looks the bindings up.

## Read the device state

`Input.plugin` keeps the device state in the world, for any system to read:

```ts
import { Input, Plugin, System } from "arcadekit";

const Steer = System.tick("game/Steer", function* () {
  const keys = yield* Input.Keyboard;
  const pointer = yield* Input.Pointer;
  const left = keys.down("ArrowLeft"); // held
  const jump = keys.pressed("Space"); // went down this tick
  const aim = pointer.down() ? { x: pointer.x, y: pointer.y } : undefined;
});

const Game = Plugin.make("game/Game", {
  plugins: [Input.plugin],
  systems: [Steer],
});
```

- `Input.Keyboard` has `down`, `pressed`, and `released`. `Input.Pointer` has `x`, `y`, and the same three for a button, the primary button by default. `Input.Gamepad(index)` has `axis(n)` and the same three for a button.
- `pressed` and `released` are true during the one tick that first sees the change. Every system of that tick sees them, and so do the handlers of the actions that the tick applies. The handler of an action bound to a key sees the press that issued it.
- A key pressed and released between two ticks is both pressed and released in the same tick, and isn't down. A held key released and pressed again between two ticks is both released and pressed in the same tick, and is down.
- A button pressed twice between two samples of the devices counts as one press.
- The changes since the last tick form one action, `Input.Report`. The app logs it only when something changed, so holding a key logs nothing.
- The device state is a singleton. It is saved with the game, restored when an action is refused, and included in the hash once something has been pressed. A game nobody has touched hashes the same as one with no input at all.
- The devices override a save. When a game is loaded from a save in which a key was held, and the key isn't down now, the first sample releases it.
- The device state describes one player's devices. For several players, on one machine or several, bind each player's devices to actions that carry the player.

Bindings don't require `Input.plugin`, and a game can use both.

## Name keys, buttons, and axes

A key's code is the browser's `KeyboardEvent.code`, such as `"KeyA"`, `"Space"`, or `"ArrowLeft"`. Other codes come from `Input.pointerButton(n)`, `Input.padButton(pad, n)`, and `Input.padAxis(pad, n)`. The pointer's position is the axes `Input.pointerX` and `Input.pointerY`, in CSS pixels from the top left of the `target` passed to `Browser.runMain`. If your canvas is drawn at a different size from its CSS size, convert the position yourself. A gamepad button is either down or up.

## Write an input system of your own

An input-stage system can read both the devices and the world, and issue any action. Picking the card under the pointer needs both:

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

const Pick = System.input("game/Pick", function* () {
  const devices = yield* Input.Devices;
  if (!devices.pressed.includes(Input.pointerButton())) {
    return;
  }
  const x = devices.axes.get(Input.pointerX) ?? 0;
  const actions = yield* Action.Actions;
  (yield* Cards).each((card, entity) => {
    if (card.left <= x && x < card.right) {
      actions.enqueue(PlayCard, { card: entity });
    }
  });
});
```

`Input.Devices` is the current sample, the same for every system of the stage. It holds the buttons that are `down`, the buttons `pressed` and `released` since the previous sample, the `axes`, and the axes that `moved`. It isn't part of the game, so a system of the tick or the frame stage can't require it. Those systems read the device state that the game keeps: `Input.Keyboard`, `Input.Pointer`, and `Input.Gamepad`.

## Run the input stage

A driver runs the input stage just before each tick. A tick doesn't read the devices, so a game that steps its app by hand calls `app.input()` before each `app.tick(delta)` that should receive them.

- The stage reads the devices once per run. A frame with no tick due reads nothing, and the presses in between wait for the next tick, so a quick tap between two frames is never lost.
- The world is read-only here, as in the frame stage. A system issues actions with `Actions.enqueue` and changes nothing itself. The app logs the actions and applies them at the start of the next tick.
- The stage reads events through its own reader, each event once. It receives what a tick's systems emitted, what its actions emitted, and `Action.Rejected`, so a system that issued an action learns that it was refused. When the stage doesn't run at all, the app keeps its events for up to 600 ticks.
- A replay doesn't run the stage, because the log already holds what the devices reported. A tool that re-runs a game from its log ticks it with `app.tick(delta)` alone. See [replays](replays.md).

The simulation can't tell whether its devices are read. A game played from a keyboard and its replay have the same hash at every tick.

## Choose where device input comes from

`Input.Source` is where device input comes from. By default there is none, which suits a replay, a server, and most tests.

- Having no devices differs from having devices with nothing pressed. With no source, the device state stays as last reported. A game fed its reports from a log or from another machine can therefore run under a driver, input stage included, and plays out the same way.
- In a page, `Browser.runMain` provides the page's keyboard, pointer, and gamepads. The pointer is a mouse, a pen, or a finger. `Browser.layer(options)` provides the same devices to a program that starts itself. [Run a game in a page](running-a-game.md#run-a-game-in-a-page) lists the options.
- A held key goes down once, and everything held is released when the page loses focus. Mouse buttons held together are tracked one by one.
- `App.make` listens to the devices in the app's own scope, and stops when the app is closed. The devices are heard for as long as the app is open, wherever `Browser.layer` is provided. Each app listens for itself. Reading the devices after the app is closed throws an error that says so.
- A test, a tool, or on-screen controls use `Input.makeManualSource()`. Drive it by hand with `press`, `release`, `tap`, and `move`, and provide it with `Input.layer(source)`. See [testing](testing.md).

Reading the devices when nothing changed costs 1.4 µs per tick. A tick in which a key went down or up costs 5.2 µs in total, for the read, the action, and the tick that applies it.

## Read more

- [`Input`](/reference/arcadekit/Input) and [`Browser`](/reference/arcadekit/Browser) in the API reference.
- [Ticks and frames](../concepts/ticks-and-frames.md), for the three stages.
