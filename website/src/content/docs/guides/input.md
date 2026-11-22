---
title: "Input"
description: "Keyboard, pointer and gamepad input reaches your game as actions, through the same log as all outside input, so replays need no devices."
---

The keyboard, pointer and gamepads are outside the game. What they report reaches it as actions, through the same log as every other outside input, so a replay needs no devices. This guide covers the two ways to read them: bindings, and the device state.

## Bindings

`Input.bind` maps the devices to your game's own actions. It creates an input-stage system, which runs before each tick:

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

- `Input.onPress`, `Input.onRelease` and `Input.onMove` issue an action when one of their codes is pressed, released or moved. With several codes, the action is issued once when any of them fires.
- The payload is either a value, or a function of the devices for an action that needs the pointer's position. The compiler checks it against the action.
- Handlers know nothing about keys. You can change the keys without changing the game or its replays, and the log records `Fire`, not which button triggered it.
- Bindings are fixed when the system is created. To let players choose their keys, write an input-stage system that looks the bindings up.

## Device state

`Input.plugin` keeps the device state in the world, for any system to read:

```ts
import { Input, Plugin, System } from "arcadekit";

const Steer = System.make("game/Steer", function* () {
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

- `Input.Keyboard` has `down`, `pressed` and `released`. `Input.Pointer` has `x`, `y` and the same three for a button, the primary button by default. `Input.Gamepad(index)` has `axis(n)` and the same three for a button.
- `pressed` and `released` are true during the one tick that first sees the change, for every system of that tick and for the handlers of the actions it applies: an action bound to a key sees the press that issued it.
- A key pressed and released between two ticks is both pressed and released in the same tick, and isn't down. A held key released and pressed again between two ticks is both released and pressed in the same tick, and is down.
- A button pressed twice between two samples of the devices counts as one press.
- The changes since the last tick form one action, `Input.Report`, logged only when something changed. Holding a key logs nothing.
- The device state is a singleton: saved with the game, restored when an action is refused, and included in the hash once something has been pressed. A game nobody has touched hashes the same as one with no input at all.
- The devices are the source of truth. If a game is loaded from a save in which a key was held, and the key isn't down now, it is released at the first sample.
- The device state describes one player's devices. For several players, on one machine or several, bind each player's devices to actions that carry the player.

Bindings don't require `Input.plugin`, and a game can use both.

## Codes

A key's code is the browser's `KeyboardEvent.code`: `"KeyA"`, `"Space"`, `"ArrowLeft"`. Other codes come from `Input.pointerButton(n)`, `Input.padButton(pad, n)` and `Input.padAxis(pad, n)`. The pointer's position is `Input.pointerX` and `Input.pointerY`, in CSS pixels from the top left of the `target` passed to `Browser.runMain`. If your canvas is drawn at a different size from its CSS size, convert the position yourself. A gamepad button is either down or up.

## Custom input systems

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

const Pick = System.make("game/Pick", function* () {
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
}).pipe(System.inStage("input"));
```

`Input.Devices` is the current sample, the same for every system of the stage: the buttons that are `down`, those `pressed` and `released` since the previous sample, the `axes`, and those that `moved`. It isn't part of the game, so its fields throw in the tick and in the frame stage, where systems read the device state instead.

## The input stage

The input stage runs just before a tick. A driver runs it, and a tick that finds it hasn't run runs it itself, so a game that steps its app with `app.tick(delta)` receives its keys with no extra code.

- The devices are read once per run. A frame with no tick due reads nothing, and presses in the meantime are kept for the next tick, so a quick tap is never lost between two frames.
- The world is read-only here, as in the frame stage: a system issues actions with `Actions.enqueue` and changes nothing itself. The actions are logged and applied at the start of the following tick.
- It receives events through its own reader, each once: what a tick's systems emitted, what its actions emitted, and `Action.Rejected`, so a system that issued an action learns it was refused. Events are kept for it for up to 600 ticks when it doesn't run at all.
- A replay doesn't run it, since the log already holds what the devices reported. `Journal.replay` ticks with `app.tick(delta, { input: false })`, a tick that reads nothing. A tool that re-runs a game from its log by hand does the same, or the keys of the machine it runs on leak into the game. See [replays](replays.md).

The simulation can't tell whether its devices are read: a game played from a keyboard and its replay have the same hash at every tick.

## Device sources

`Input.Source` determines where device input comes from. By default there is none, which is what a replay, a server and most tests want.

- Having no devices differs from having devices with nothing pressed: the device state stays as last reported. A game fed its reports from a log or from another machine can therefore run under a driver, input stage and all, and plays out the same way.
- In a page, `Browser.runMain` provides the page's keyboard, pointer (a mouse, a pen or a finger) and gamepads, as `Browser.layer(options)` does for a program that starts itself. Its options are listed under [running a game](running-a-game.md#in-a-page).
- A held key goes down once, and everything held is released when the page loses focus. Mouse buttons held together are tracked individually.
- `Browser.layer` listens until its scope closes, so provide it to the whole program. Provided to `App.make` alone, it is released as soon as the app is created, and reports that when it is read.
- A test, a tool or on-screen controls use `Input.makeManualSource()`, driven by hand with `press`, `release`, `tap` and `move`, and provided as `Input.Source`. See [testing](testing.md).

Reading the devices when nothing changed costs 1.4 µs per tick. A tick in which a key went down or up costs 5.2 µs in total: the read, the action, and the tick that applies it.

## Read more

- [`Input`](/reference/arcadekit/Input) and [`Browser`](/reference/arcadekit/Browser) in the API reference.
- [Ticks and frames](../concepts/ticks-and-frames.md), for the three stages.
