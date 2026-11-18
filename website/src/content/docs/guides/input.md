---
title: "Input"
description: "The keyboard, the pointer and the gamepads are outside the game. What they say reaches it as actions, through the same log as everything else from outside, so a replay needs no devices."
---

The keyboard, the pointer and the gamepads are outside the game. What they say reaches it as actions, through the same log as everything else from outside, so a replay needs no devices. This guide covers the two ways to read them: bindings, and the picture of the devices.

## Bindings

`Input.bind` turns the devices into the game's own actions. It makes a system of the input stage, which runs before each tick:

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

- `Input.onPress`, `Input.onRelease` and `Input.onMove` each issue an action when one of their codes is pressed, released or moved. Given several codes, the action is issued once when any of them does it.
- The payload is a value, or a function of the devices for an action that needs to know where the pointer is. The compiler checks it against the action.
- The handlers know nothing of keys. The keys can change without the game or its replays changing, and the log says `Fire`, not which button.

## The picture of the devices

`Input.plugin` keeps what the devices say in the world, for any system to read:

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

- `Input.Keyboard` has `down`, `pressed` and `released`. `Input.Pointer` has `x`, `y` and the same three for a button, the main one unless told. `Input.Gamepad(index)` has `axis(n)` and the three for a button.
- `pressed` and `released` are true in the one tick that first sees the change, for every system of that tick and for the handlers of the actions it applies: an action bound to a key sees the press that issued it.
- A key that went down and up between two ticks was pressed and released in the same tick, and is not down. A held key that was let go and pressed again between two ticks was released and pressed in the same tick, and is down.
- What changed since the last tick is one action, `Input.Report`, logged only when something changed. Holding a key still logs nothing.
- The picture is a singleton: saved with the game, put back when an action is refused, and counted in the hash once something was pressed. A game nobody has touched hashes as one that has no input at all.
- The devices are the truth. A game loaded from a save in which a key was held, where the key is no longer down, lets it go at the first reading.
- It is one picture, of one player's devices.

Bindings don't need `Input.plugin`, and a game can use both.

## Codes

A key's code is the browser's `KeyboardEvent.code`: `"KeyA"`, `"Space"`, `"ArrowLeft"`. The others are made by `Input.pointerButton(n)`, `Input.padButton(pad, n)` and `Input.padAxis(pad, n)`. The pointer's place is `Input.pointerX` and `Input.pointerY`, in CSS pixels from the top left of the `target` given to `Browser.runMain`.

## When a binding isn't enough

A system of the input stage can read the devices and the world, and issue what it likes. Picking the card under the pointer needs both:

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
const Cards = Query.all(Card).pipe(Query.reads());
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

`Input.Devices` is what the devices say, the same for every system of the stage: the buttons that are `down`, the ones `pressed` and `released` since the sample before, the `axes`, and the ones that `moved`. It is no part of the game, so its fields throw in the tick and in the frame stage, where a system reads the picture.

## The input stage

The input stage runs just before a tick. A driver runs it there, and a tick that finds nobody did runs it itself, so a game that steps its app by hand with `app.tick(delta)` hears its keys with no more than that.

- The devices are read once per run. A frame in which no tick is due reads nothing, and what was pressed meanwhile is there for the next tick, so a quick tap is never lost between two frames.
- The world is frozen there, as in the frame stage: a system issues actions with `Actions.enqueue` and changes nothing itself. They are logged and applied at the start of the tick that follows.
- It hears events from a place of its own, each once: what a tick's systems emitted, what its actions emitted, and `Action.Rejected`, so a system that issued an action hears that it was refused. They are kept for it for up to 600 ticks when it doesn't run at all.
- A replay doesn't run it: what the devices said is in its log. `App.replay` ticks with `app.tick(delta, { input: false })`, a tick that reads nothing, and a tool that runs a game again from its log by hand says the same, or the keys of the machine it runs on join in. See [replays](replays.md).

The simulation can't tell whether its devices are read: a game played from a keyboard and its replay have the same hash at every tick.

## Where the devices come from

`Input.Source` says where. By default there are none, which is what a replay, a server and most tests want.

- No devices is not the same as devices with nothing pressed: the picture is left as it was last reported. So a game that is given its reports from a log or from another machine can be run by a driver, input stage and all, and goes the same way.
- In a page, `Browser.runMain` provides the page's keyboard, pointer (a mouse, a pen or a finger) and gamepads, as `Browser.layer(options)` does for a program that starts itself. Its options are listed under [running a game](running-a-game.md#in-a-page).
- A key held down went down once, and everything held is let go when the page loses focus. The buttons of a mouse held together are followed one by one.
- `Browser.layer` listens until its scope closes, so it is provided to the whole program. Provided to `App.make` alone it is let go as soon as the app is made, and says so when it is read.
- A test, a tool or controls drawn on the screen use `Input.makeManualSource()`, worked by hand with `press`, `release`, `tap` and `move`, and provided as `Input.Source`. See [testing](testing.md).

Reading the devices when nothing changed costs 1.4 µs a tick. A tick in which a key went down or up costs 5.2 µs in all: the reading, the action and the tick that applies it.

## Not done yet

- The picture of the devices is one player's. Several players, on one machine or on several, bind their devices to actions that say whose they are.
- A gamepad's button is down or it is not: how far a trigger is pressed is not read. Nor are the wheel, text as it is typed, more than one finger at a time, or a pointer that is locked to the page.
- A button that is pressed twice between two readings of the devices was pressed once.
- The pointer's place is in CSS pixels of its target. A canvas that is drawn larger or smaller than its own size has to convert.
- Bindings are fixed when the system is made. A game that lets its player choose the keys writes a system of the input stage that looks them up.

## Read more

- [`Input`](/reference/arcadekit/Input) and [`Browser`](/reference/arcadekit/Browser) in the API reference.
- [Ticks and frames](../concepts/ticks-and-frames.md), for the three stages.
