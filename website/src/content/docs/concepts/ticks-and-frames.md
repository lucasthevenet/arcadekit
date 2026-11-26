---
title: "Ticks and frames"
description: "Your simulation ticks at a fixed rate and the screen repaints at its own. arcadekit keeps the two apart, with a third stage for device input."
---

A **tick** advances your game's simulation by one fixed step, and a **frame** draws the game once per repaint of the screen. arcadekit keeps the two apart, and adds a third stage, the **input stage**, for what the input devices report.

## The three stages

| Stage | When it runs | What runs there | Can change the game |
| --- | --- | --- | --- |
| Input | Just before a tick | Systems that read the devices and issue actions | No. It issues actions, which the tick applies |
| Tick | At a fixed rate, such as 60 per second | Your rules | Yes |
| Frame | Once per repaint, between ticks | Rendering, sound and UI updates | No |

`System.tick`, `System.frame` and `System.input` make a system of each stage. [Place a system in a stage](../guides/systems.md#place-a-system-in-a-stage) shows how.

## A tick is one fixed step

Each tick runs these steps in order:

1. Apply the actions queued for it. A refused action becomes an `Action.Rejected` event.
2. Advance game time by one step.
3. Enter any states that were requested, running their hooks.
4. Run every system in order, applying each one's commands when it finishes.

Every tick has the same length, `delta`, however busy the machine is. Systems read it from `Time`. The fixed step lets a tick produce the same result from the same inputs on any machine.

A tick has three stages of its own, `"preUpdate"`, `"update"` and `"postUpdate"`, and runs each in full before the next. Systems run in `"update"` by default. Inside a stage, systems run in the order they are listed, after those of the plugins they depend on. The other two stages let a system run before or after every system of `"update"`, a dependency's included.

## Drawing never changes the game

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

const Draw = System.frame("game/Draw", function* () {
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
});
```

The world is read-only during the frame stage. A frame system reads queries, singletons, states, `Time`, events and change queries. Code that spawns, sets a component, writes a singleton or a state, runs a command, assigns in `each` or emits an event doesn't compile there, and a cast finds nothing to call: its world has no `set`, its events have no `emit`, and it has no `Commands`. The input stage and `app.read` are handed the same. `yield* Frame` describes the current frame:

| Field | Description |
| --- | --- |
| `alpha` | How far the frame is between the last tick and the next, from 0 to 1, for drawing a moving entity between its last position and its next |
| `delta` | Real seconds since the previous frame |
| `count` | How many frames have run, including this one |

`Frame` holds real-time values, so a system of the tick or the input stage cannot require it. A system of the tick reads `Time`.

Everything else depends on one rule: **drawing never changes the game.** A game that is drawn has the same hash, log and save as one that isn't. A replay or a server therefore runs no frame stage at all, and ends on the same world. The frame stage is kept apart from the simulation in four more ways:

- It tracks events and change queries apart from the tick. Events are kept until the frame stage has run, so it sees each event once, however many ticks ran since the last frame. After 600 ticks without a frame, the app takes the frame stage to be gone and stops keeping events for it. A save doesn't hold this tracking, so a loaded game redraws everything.
- Its random numbers come from a separate generator, seeded like the world's but not part of it. Visual effects can be random without changing the game.
- An action it issues with `Actions.enqueue` counts as outside input, like a button press. The app logs it and applies it at the start of the next tick, and a replay applies it again without drawing a frame.
- State it keeps between frames, such as a mesh or a playing sound, lives in a service of its own, not in the world.

Sound plays from the frame stage too, driven by the events the ticks emitted. The simulation never plays sound.

### A frame's stages run before and after drawing

Like a tick, a frame has three stages and runs each in full before the next: `"preFrame"`, `"frame"` and `"postFrame"`. Your systems run in `"frame"`.

- `"preFrame"` is for what every frame system depends on. [`Assets.during`](../guides/assets.md) runs there, so every frame system sees the same set of loaded assets, wherever it is listed.
- `"postFrame"` is for what needs everything drawn first. [`@arcadekit/three`](../guides/drawing-with-three.md) renders the scene there, so a system that moves the camera needs no ordering.

In every other way, all three are part of the frame stage. A frame system and a tick system are never ordered against each other.

### Two changes are caught after they happen

Two kinds of change aren't refused where they happen:

- A draw from `world.random` is detected when the frame ends. The app restores the generator, so the game is unchanged, and `frame` throws.
- A write through the raw columns of `eachChunk` is refused only when you ask for it. With `App.make(game, { verifyFrames: true })`, `eachChunk` copies the columns it hands out read-only, which in these stages is all of them, and throws when a loop changed one, after putting it back. The app also hashes the world before the stage and after each of its systems. When a hash differs, `frame` dies with `App.FrameChangedWorld`, which names the system. The checks cost a copy of each column handed out and a hash of the world per system, so use them in development and tests. They check the input stage the same way.

## Input reaches the game as actions

The keyboard, pointer and gamepads are outside the game. Before each tick, the input stage reads them once. Its systems turn what the devices report into your game's own actions, such as `Fire`, `Jump` and `Move`. The app logs those actions and applies them at the start of the tick. The world is read-only here, as in the frame stage.

A replay therefore reads no device, because the log already holds what the devices reported, as actions. See [input](../guides/input.md).

## A driver runs the stages

- **`Driver.run`** makes an app of a game and runs it until it is interrupted. On each repaint it runs the ticks that are due at a fixed `hz`, then the frame. In a page it follows `requestAnimationFrame`, and under Node it uses a timer.
- **`yield* app.tick(delta)`** runs one tick by hand, for a test or a game that steps itself. A tick reads no device. `app.input()` runs the input stage, and `app.frame(alpha, delta)` runs the frame stage. Without an `alpha`, `app.frame()` draws the game where its last tick left it, at an `alpha` of 1. Each returns an Effect, one for the whole stage, which fails with what a system fails with.
- **`Driver.fixedStep`** returns a step that runs the ticks that are due for a given amount of real time, each after the input stage, then the frame.
- **`Driver.frames`** is the loop that `Driver.run` uses, for a program that creates its app itself. **`Driver.interval`** does the same on a timer.

A turn-based game, a puzzle or a menu has nothing to do between moves. With `ticks: "whenNeeded"`, `Driver.run` still draws every frame, but ticks only while something is pending: an action, a state change, a system that asked for another tick, or an unread event. See [running a game](../guides/running-a-game.md).

Ticks and frames don't line up, so an entity drawn where the last tick left it stutters. A frame system of your own draws it between two ticks from a velocity or a previous position the simulation keeps, as `Draw` does above. [Interpolation](../guides/between-two-ticks.md) shows how `@arcadekit/three` does the same with `smooth: true`.

## Read more

- [`App`](/reference/arcadekit/App) and [`Driver`](/reference/arcadekit/Driver) in the API reference.
- [Input](../guides/input.md), [sound](../guides/sound.md) and [drawing with Three.js](../guides/drawing-with-three.md).
