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

- `Input.onPress`, `Input.onRelease` and `Input.onMove` each issue an action when one of their codes is pressed, released or moved.
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

- `Input.Keyboard` has `down`, `pressed` and `released`. `Input.Pointer` has `x`, `y` and the same three for a button. `Input.Gamepad(index)` has `axis(n)` and the three for a button.
- `pressed` and `released` are true in the one tick that first sees the change, for every system of that tick.
- What changed since the last tick is one action, `Input.Report`, logged only when something changed. Holding a key still logs nothing.
- The picture is a singleton: saved with the game and counted in the hash.
- It is one picture, of one player's devices.

Bindings don't need `Input.plugin`, and a game can use both.

## Codes

A key's code is the browser's `KeyboardEvent.code`: `"KeyA"`, `"Space"`, `"ArrowLeft"`. The others are made by `Input.pointerButton(n)`, `Input.padButton(pad, n)` and `Input.padAxis(pad, n)`. The pointer's place is `Input.pointerX` and `Input.pointerY`, in CSS pixels from the top left of the `target` given to `Browser.runMain`.

## When a binding isn't enough

A system of the input stage can read the devices and the world, and issue what it likes. Picking the card under the pointer needs both:

```ts sketch
const Pick = System.make("game/Pick", function* () {
  const devices = yield* Input.Devices;
  if (!devices.pressed.includes(Input.pointerButton())) {
    return;
  }
  const card = cardAt(yield* Cards, devices.axes.get(Input.pointerX) ?? 0);
  if (card !== undefined) {
    (yield* Action.Actions).enqueue(PlayCard, { card });
  }
}).pipe(System.inStage("input"));
```

The world is frozen in the input stage, as in the frame stage: a system there issues actions and changes nothing itself.

## Where the devices come from

`Input.Source` says where. By default there are none, which is what a replay, a server and most tests want. In a page, `Browser.runMain` provides the page's. A test uses `Input.makeManualSource()`, worked by hand with `press`, `release`, `tap` and `move`. See [testing](testing.md).

## Read more

- [`Input`](/reference/arcadekit/Input) in the API reference. What is not read yet: a trigger's pressure, the wheel, typed text, more than one finger.
