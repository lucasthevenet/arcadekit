---
title: "Ticks and frames"
description: "Your simulation ticks at a fixed rate and the screen repaints at its own. arcadekit keeps the two apart, with a third stage for device input."
---

Your game's simulation ticks at a fixed rate, while the screen repaints at its own rate. arcadekit keeps the two apart, and adds a third stage for what the input devices report.

## The three stages

| Stage | When it runs | What runs there | Can change the game |
| --- | --- | --- | --- |
| Input | Just before a tick | Systems that read the devices and issue actions | No: it issues actions, which the tick applies |
| Tick | At a fixed rate, such as 60 per second | Your rules | Yes |
| Frame | Once per repaint, between ticks | Rendering, sound and UI updates | No |

A system runs in the tick unless you place it elsewhere with `System.inStage("frame")` or `System.inStage("input")`.

## The tick

Each tick runs these steps in order:

1. Apply the actions queued for it. A refused action becomes an `Action.Rejected` event.
2. Advance game time by one step.
3. Enter any states that were requested, running their hooks.
4. Run every system in order, applying each one's commands when it finishes.
5. Resume the scripts waiting for this tick or for an event.

Every tick has the same length, `delta`, whatever the machine is doing, and systems read it from `Time`. This fixed timestep is what makes a tick produce the same result from the same inputs on any machine.

A tick has three stages of its own, `"preUpdate"`, `"update"` and `"postUpdate"`, each run in full before the next. Systems run in `"update"` by default.

## The frame

A frame draws the game between two ticks:

```ts
import { Component, Field, Frame, Query, System, Time } from "arcadekit";

const Position = Component.define("game/Position", {
  x: Field.f32,
  y: Field.f32,
});
const Velocity = Component.define("game/Velocity", {
  x: Field.f32,
  y: Field.f32,
});
const Moving = Query.all(Position, Velocity);

const context = document.querySelector("canvas")!.getContext("2d")!;

const Draw = System.make("game/Draw", function* () {
  const { alpha } = yield* Frame; // how far this frame is between two ticks
  const { delta } = yield* Time; // the length of a tick
  const ahead = delta * alpha;
  (yield* Moving).eachChunk((start, end, position, velocity) => {
    for (let i = start; i < end; i++) {
      const x = position.x[i]! + velocity.x[i]! * ahead;
      const y = position.y[i]! + velocity.y[i]! * ahead;
      context.fillRect(x, y, 4, 4);
    }
  });
}).pipe(System.inStage("frame"));
```

The world is read-only during the frame stage. Anything that would change the game throws where it happens, with an explanation: spawning or despawning, adding or removing a component, `world.set`, writing a singleton or a state, a command, an assignment in `each`, emitting an event, starting a script, or dispatching an action.

A frame system can read anything: queries, singletons, states, `Time`, events and change queries. `yield* Frame` describes the current frame:

| Field | Description |
| --- | --- |
| `alpha` | How far the frame is between the last tick and the next, from 0 to 1, for interpolating a moving entity between its last position and its next |
| `delta` | Real seconds since the previous frame |
| `count` | How many frames have run, including this one |

These are real-time values, so tick systems can't read them: accessing a field of `Frame` in a tick throws and points you to `Time`.

This is the rule everything else depends on: **drawing never changes the game.** A game that is drawn has the same hash, log and save as one that isn't, so a replay or a server runs no frame stage at all and ends on the same world. The frame stage is isolated from the simulation in four more ways:

- It tracks events and change queries separately from the tick. Events are kept until the frame stage has run, so it sees each event once however many ticks ran since the last frame. They are kept for up to 600 ticks, after which a frame stage that never runs is assumed gone. This tracking isn't saved, so a loaded game redraws everything.
- Its random numbers come from a separate generator, seeded like the world's but not part of it. Visual effects can be random without changing the game.
- An action it issues with `Actions.enqueue` counts as outside input, like a button press: it is logged, applied at the start of the next tick, and replayed without a frame being drawn.
- State it keeps between frames, such as a mesh or a playing sound, lives in a service of its own, not in the world.

Sound plays from the frame stage too, driven by the events the ticks emitted. The simulation never plays sound.

### Frame stages

Like a tick, a frame has three stages, each run in full before the next: `"preFrame"`, `"frame"` and `"postFrame"`. Your systems run in `"frame"`.

- `"preFrame"` is for what every frame system depends on. [`Assets.during`](../guides/assets.md) runs there, so every frame system sees the same set of loaded assets, wherever it is listed.
- `"postFrame"` is for what needs everything drawn first. [`@arcadekit/three`](../guides/drawing-with-three.md) renders the scene there, so a system that moves the camera needs no ordering.

All three are part of the frame stage in every other way, and `app.frameOrder` lists their systems in running order. `System.before` and `System.after` order a system within its stage; frame systems and tick systems are never ordered against each other. A frame system accepts `System.runIf` like any other. State hooks don't belong there, since states are entered by ticks.

### What the frame stage doesn't block

Two kinds of change aren't refused where they happen:

- A draw from `world.random` is detected when the frame ends: the generator is restored, so the game is unchanged, and `frame` throws.
- A write through the raw columns of `eachChunk` is only detected when you ask for it. `App.make({ verifyFrames: true })` hashes the world before the stage and after each of its systems, and `frame` dies with `App.FrameChangedWorld`, which names the system. This costs one hash of the world per system, so use it in development and tests. It checks the input stage the same way.

## The input stage

The keyboard, pointer and gamepads are outside the game. Before each tick, the input stage reads them once, and its systems turn what they report into your game's own actions: `Fire`, `Jump`, `Move`. Those actions are logged and applied at the start of the tick. The world is read-only here, as in the frame stage.

So a replay reads no device: the log already holds what the devices reported, as actions. See [input](../guides/input.md).

## What drives the stages

- **`App.run`** creates the app and runs it until interrupted: on each repaint, the ticks that are due at a fixed `hz`, then the frame. In a page it follows `requestAnimationFrame`; under Node it uses a timer.
- **`app.tick(delta)`** runs one tick by hand, for a test or a game that steps itself. It runs the input stage first if nothing has since the previous tick. `app.frame(alpha, delta)` runs the frame stage.
- **`Driver.fixedStep`** runs the ticks that are due for a given amount of real time, each after the input stage, then the frame.
- **`Driver.frames`** is the loop `App.run` uses, for a program that creates its app itself, and **`Driver.interval`** does the same on a timer.

A turn-based game, a puzzle or a menu has nothing to do between moves. With `ticks: "whenNeeded"`, `App.run` still draws every frame but only ticks while something is pending: an action, a state change, a sleeping script, an unread event. See [running a game](../guides/running-a-game.md).

To draw a moving entity between two ticks in a frame system of your own, compute its position from a velocity or a previous position the simulation keeps, as `Draw` does above. [`@arcadekit/three`](../guides/drawing-with-three.md) does this for what it draws, with `smooth: true`.

## Read more

- [`App`](/reference/arcadekit/App) and [`Driver`](/reference/arcadekit/Driver) in the API reference.
- [Input](../guides/input.md), [sound](../guides/sound.md) and [drawing with Three.js](../guides/drawing-with-three.md).
