---
title: "Input"
description: "A game names what its player does as controls bound to keys, pointer buttons and gamepads, and its rules read the controls. Bindings change while it runs, and what the controls said reaches the game through its log, so replays need no devices."
---

**Input** is what the keyboard, the pointer, and the gamepads report. A game names what its player does, a **control**, binds it to the devices, and reads the control in its systems, which know nothing of keys. What the controls say reaches the game as an action, through the same log as every other input from outside the game, so a replay needs no devices and no bindings.

## Declare the controls

```ts
import { Input, Plugin, Singleton, System, Time, Field } from "arcadekit";

const Jump = Input.button("game/Jump", ["Space", Input.padButton(0, 0)]);
const Move = Input.stick("game/Move", {
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  up: ["KeyW", "ArrowUp"],
  down: ["KeyS", "ArrowDown"],
  pad: Input.padStick(0, "left"),
});

const Hero = Singleton.define(
  "game/Hero",
  { x: Field.f32, y: Field.f32, jumps: Field.i32 },
  { x: 0, y: 0, jumps: 0 }
);

const Walk = System.tick("game/Walk", function* () {
  const hero = yield* Hero.writes;
  const { delta } = yield* Time;
  const move = yield* Move; // { x, y }: y up, of length 1 at most
  hero.x += move.x * 5 * delta;
  hero.y += move.y * 5 * delta;
  if ((yield* Jump).pressed) {
    hero.jumps += 1;
  }
});

const Game = Plugin.make("game/Game", {
  plugins: [Input.controls("game/Controls", [Jump, Move])],
  systems: [Walk],
});
```

- `Input.button(name, codes)` is held while any of its codes is down. `yield*` gives `{ held, pressed, released }`. Pressing a second of its codes while one is held is no new press.
- `Input.axis(name, { negative, positive, pad })` is a number from -1 to 1: 1 while a `positive` button is held, -1 while a `negative` one is, 0 while both or neither are, plus a gamepad's axis.
- `Input.stick(name, { left, right, up, down, pad })` is a direction `{ x, y }`, with y up and of length 1 at most, so two keys held together make a diagonal of length 1. A gamepad's stick counts once it is `deadzone` from its center, 0.2 by default in any direction, and counts from 0 there.
- `Input.controls(name, controls)` declares a game's controls, and installs `Input.plugin`. A game that reads a control it doesn't declare doesn't compile: `App.make` requires `Input.Declared<"game/Jump">` from outside. Several plugins can each declare their own, and two controls of one name are refused when the app is made.
- A control's name is its feature, a slash, and what it is, as for a component. No device's code has a slash, so the compiler refuses a name without one.

Before each tick, the input stage works out what every control says of the devices, and reports what changed as one action, `Input.Report`, beside the devices' own state. The log records `"game/Jump"` going down, so a replay plays the same game whatever its bindings. The app logs the action only when something changed, so holding a key logs nothing.

## Read a control in each stage

A control is read the same way in every stage, and each stage is told what it can use:

| Stage | `held`, an axis, a stick | `pressed` and `released` |
| --- | --- | --- |
| The tick, and an action's handler | What the world holds this tick | Changed in this tick |
| The frame stage | What the world holds | Changed since the last frame |
| The input stage | What this run's sample says, with the app's bindings | Changed since the last sample |

- In the tick, `pressed` and `released` are true during the one tick that first sees the change. Every system of that tick sees them, and so do the handlers of the actions that the tick applies.
- A frame system sees each press and each release once, in the first frame drawn after its tick, whether a tick has several frames or a frame has several ticks. After a [rewind](capturing-and-rewinding.md), the ticks run again are new to it, as their events are. After a rewind with `{ again: true }`, as a [rollback session](sessions.md) makes on every wrong prediction, a press the last frame showed isn't shown again, and one that only the ticks run again have is shown once.
- A button pressed and released between two ticks is both pressed and released in the same tick, and isn't held. A held button released and pressed again between two ticks is both released and pressed, and is held.
- The state is a singleton of the world. It is saved with the game, restored when an action is refused, and included in the hash once something has been pressed. A game nobody has touched hashes the same as one with no input at all.
- The devices override a save. When a game is loaded from a save in which a key was held, and the key isn't down now, the first sample releases it.
- The state describes one player's devices. For several players, on one machine or several, [write an input system](devices.md#write-an-input-system-of-your-own) that issues actions that carry the player.

## Rebind a control

```ts
import { Input, System } from "arcadekit";

const Jump = Input.button("game/Jump", ["Space", Input.padButton(0, 0)]);

// R, then the key the jump is to be.
const Asking = System.local(() => ({ asking: false }));

const Settings = System.input("game/Settings", function* () {
  const menu = yield* Asking;
  const { pressed } = yield* Input.Devices;
  if (!menu.asking) {
    menu.asking = pressed.includes("KeyR");
    return;
  }
  const key = pressed.find(Input.isKeyCode);
  if (key !== undefined) {
    yield* Input.rebind(Jump, [key, Input.padButton(0, 0)]);
    menu.asking = false;
  }
});
```

- `Input.rebind(control, bindings)` takes effect at the next sample of the devices. The input systems after it in the same sample read the bindings the sample began with. A frame or an input system rebinds, and a system of the tick that rebinds doesn't compile.
- Bindings are settings, not the game. They are outside the world, so a save, the hash, the log and a rewind leave them as they are. Each app has its own, made from what each control was declared with, and let go of when it is closed.
- `Input.rebind(Jump, Jump.bindings)` puts back what the control was declared with. `Input.bindingsOf(Jump)` gives what it is bound to now, for a menu that shows the player's keys.
- A key that is down at the next sample, as the one the player pressed to choose and still holds, moves the control only from its next press. The control stays up until the key is let go and pressed again. A key the control was already bound to the same way counts as it did.

## Keep the player's keys from a settings menu

A settings menu runs in the page's UI, outside every system. It rebinds through `Input.settingsOf`, and keeps the keys in a [setting](settings.md), which the next visit to the page reads when the game starts:

```ts
import { App, Driver, Input, Setting } from "arcadekit";
import { Browser } from "arcadekit/browser";
import { Effect } from "effect";

const Jump = Input.button("game/Jump", ["Space", Input.padButton(0, 0)]);
const Controls = Input.controls("game/Controls", [Jump]);
const Game = App.define({ plugins: [Controls] });

// The keys the player chose, in the bindings' JSON form.
const JumpKeys = Setting.define("game/JumpKeys", Jump.schema, Jump.bindings);
const choose = document.querySelector<HTMLButtonElement>("#jump-on-k")!;

Browser.runMain(
  Driver.run(Game, {
    hz: 60,
    ready: (app) =>
      Effect.gen(function* () {
        const settings = Input.settingsOf(app, Controls);
        // The game starts with the keys kept last time, or with those it
        // declares when what was kept no longer reads.
        yield* settings.rebind(
          Jump,
          yield* Effect.orElseSucceed(JumpKeys, () => Jump.bindings)
        );
        const run = Effect.runForkWith(yield* Effect.context<Setting.Store>());
        // The menu makes K the jump, now and after a reload.
        choose.onclick = () =>
          run(
            Effect.andThen(
              settings.rebind(Jump, ["KeyK"]),
              Setting.set(JumpKeys, ["KeyK"])
            )
          );
      }),
  }).pipe(Effect.provide(Setting.layer(Browser.settings("mygame")))),
  { target: document.querySelector("canvas")! }
);
```

- `Input.settingsOf(app, Controls)` gives `rebind` and `bindingsOf` to code outside the game's systems. It takes only the controls the plugin declares, and throws for an app made without the plugin. They are the bindings `Input.rebind` changes from a system: what one changes, the other reads.
- `Jump.schema` is the schema of the control's bindings. A setting of it keeps them as JSON. A kept text that names no key fails the read with `Setting.Invalid`, and `Effect.orElseSucceed` puts the bindings the control was declared with in its place.
- The bindings stay outside the world: rebinding changes no save, no hash and no log.

## Name keys, buttons, and axes

A key's code is the browser's `KeyboardEvent.code`, such as `"KeyA"`, `"Space"`, or `"ArrowLeft"`: where the key is, whatever its layout prints on it. `Input.KeyCode` lists them, so a code spelt wrong doesn't compile, in a control's bindings, in `Input.Keyboard`, or in `preventDefault`. `Input.isKeyCode` checks a string that comes from elsewhere. Other codes come from `Input.pointerButton(n)`, `Input.padButton(pad, n)`, `Input.padAxis(pad, n)`, and `Input.padStick(pad, "left")`. The pointer's position is the axes `Input.pointerX` and `Input.pointerY`, in CSS pixels from the top left of the `target` passed to `Browser.runMain`.

A gamepad with the browser's standard mapping numbers its buttons and axes as follows. A button is either down or up, triggers included.

| Button | Xbox | PlayStation |  | Button | Xbox | PlayStation |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | A | Cross |  | 9 | Menu | Options |
| 1 | B | Circle |  | 10 | Left stick pressed | L3 |
| 2 | X | Square |  | 11 | Right stick pressed | R3 |
| 3 | Y | Triangle |  | 12 | D-pad up | D-pad up |
| 4 | LB | L1 |  | 13 | D-pad down | D-pad down |
| 5 | RB | R1 |  | 14 | D-pad left | D-pad left |
| 6 | LT | L2 |  | 15 | D-pad right | D-pad right |
| 7 | RT | R2 |  | 16 | Xbox | PS |
| 8 | View | Share |  |  |  |  |

| Axis | What it is                   | -1   | 1     |
| ---- | ---------------------------- | ---- | ----- |
| 0    | The left stick, across       | Left | Right |
| 1    | The left stick, up and down  | Up   | Down  |
| 2    | The right stick, across      | Left | Right |
| 3    | The right stick, up and down | Up   | Down  |

`Input.padStick(pad, "left")` is axes 0 and 1, and `"right"` axes 2 and 3. A stick control turns the gamepad's y around, so up is up.

## Read more

- [Devices and the input stage](devices.md): the devices by their codes, input systems of your own, and where the devices come from.
- [`Input`](/reference/arcadekit/Input) in the API reference.
- [Ticks and frames](../concepts/ticks-and-frames.md), for the three stages.
