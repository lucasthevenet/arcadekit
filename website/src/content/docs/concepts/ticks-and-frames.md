---
title: "Ticks and frames"
description: "A game's simulation ticks at a fixed rate. The screen repaints at its own. arcadekit keeps the two apart, and adds a third moment for what the devices say."
---

A game's simulation ticks at a fixed rate. The screen repaints at its own. arcadekit keeps the two apart, and adds a third moment for what the devices say.

## Three stages

| Stage | When | What runs there | May change the game |
| --- | --- | --- | --- |
| Input | Just before a tick | Systems that read the devices and issue actions | No: it issues actions, which the tick applies |
| Tick | At a fixed rate, such as 60 a second | The rules | Yes |
| Frame | Once per repaint, between ticks | What draws, plays sound, and tells a UI | No |

A system is in the tick unless it says otherwise, with `System.inStage("frame")` or `System.inStage("input")`.

## The tick

One tick, in order:

1. Apply the actions that were queued for it. A refused one becomes an `Action.Rejected` event.
2. Advance the game's time by one step.
3. Enter the states that were asked for, running their hooks.
4. Run every system in order, applying each one's commands when it finishes.
5. Resume the scripts that were waiting for this tick, or for an event.

Each tick has the same length, `delta`, whatever the machine is doing. A system reads it from `Time`. That fixed step is what lets a tick give the same result from the same inputs on any machine.

A tick has three stages of its own, `"preUpdate"`, `"update"` and `"postUpdate"`, each run whole before the next. A system is in `"update"` unless told otherwise.

## The frame

A frame draws the game as it is, between two ticks:

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
const Moving = Query.all(Position, Velocity).pipe(Query.reads());

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

The world is frozen while the frame stage runs, and whatever would change the game throws where it is made and says why: a spawn or a despawn, a component added or removed, `world.set`, a write to a singleton or a state, a command, an assignment in `each`, an event emitted, a script started, an action dispatched.

A frame system reads all it likes: queries, singletons, states, `Time`, events and change queries. `yield* Frame` tells it about the frame:

| Field | Is |
| --- | --- |
| `alpha` | How far the frame is between the last tick and the next, from 0 to 1, so a moving thing can be drawn between its last place and its next |
| `delta` | The real seconds since the frame before |
| `count` | How many frames have run, this one included |

That is real time, so a system of the tick can't read it: a field of `Frame` throws there and says to read `Time`.

This is the rule that makes the rest work: **a game that is drawn is the same game as one that is not.** It has the same hash, the same log and the same save, so a replay or a server runs no frame stage at all, and ends on the same world. The frame stage is kept apart from the game in four more ways:

- It hears events and change queries from a place of its own. Events are kept for it until it has run, so it hears each one once however many ticks ran since the last frame. They are kept for up to 600 ticks, after which a frame stage that never ran is taken to be gone. Its places are not saved: a loaded game has everything still to draw.
- Its random numbers come from a generator of its own, seeded like the world's and no part of it. Sparks don't change the game.
- An action it issues with `Actions.enqueue` is input from outside, as a button is: it is logged, applied at the start of the next tick, and replayed without a frame being drawn.
- What it has to remember from one frame to the next, a mesh or a sound that is playing, it keeps in a service of its own, not in the world.

Sound is played from the frame stage too, from the events the ticks emitted. The simulation never plays a sound.

### A frame's own stages

A frame has three stages, as a tick has, each run whole before the next: `"preFrame"`, `"frame"` and `"postFrame"`. A game's systems are in `"frame"`.

- `"preFrame"` is for what they all stand on. [`Assets.during`](../guides/assets.md) is there, so every system of a frame finds the same assets loaded, wherever it is listed.
- `"postFrame"` is for what needs everything drawn. [`@arcadekit/three`](../guides/drawing-with-three.md) puts the picture on the screen there, so a system that moves the camera says nothing about when.

All three are the frame stage in every other way, and `app.frameOrder` lists their systems in the order they run. `System.before` and `System.after` order a system within its stage: a frame's systems and a tick's are never ordered against each other. A frame system takes a condition with `System.runIf` like any other. A state's hook does not belong there: a state is entered by a tick.

### What a frame is not stopped from

Two changes are not refused where they are made:

- A draw from `world.random` is found when the frame ends: the generator is put back, so the game is as it was, and `frame` throws.
- A write through the raw columns of `eachChunk` is not found unless it is looked for. `App.make({ verifyFrames: true })` takes the world's hash before the stage and after each of its systems, and `frame` dies with `App.FrameChangedWorld`, which names the system. That costs a hash of the world per system, so it is for development and tests. It checks the input stage the same way.

## The input stage

The keyboard, the pointer and the gamepads are outside the game. Before each tick, the input stage reads them once, and its systems turn what they say into the game's own actions: `Fire`, `Jump`, `Move`. Those actions are logged and applied at the start of the tick. The world is frozen there, as in the frame stage.

So a replay reads no device: what the devices said is in the log, as actions. See [input](../guides/input.md).

## What drives them

- **`App.run`** makes the app and runs it until it is interrupted: the ticks that are due each repaint, at a fixed `hz`, then the frame. In a page that is `requestAnimationFrame`; under Node it is a timer.
- **`app.tick(delta)`** runs one tick by hand, for a test or a game that steps itself. It runs the input stage first, if nothing has since the tick before. `app.frame(alpha, delta)` runs the frame stage.
- **`Driver.fixedStep`** runs the ticks that are due for a given amount of real time, each after the input stage, then the frame.
- **`Driver.frames`** is the loop under `App.run`, for a program that makes its app itself, and **`Driver.interval`** steps the same way on a timer.

A game of turns, a puzzle or a menu has nothing to do between moves. With `ticks: "whenNeeded"`, `App.run` still draws every frame but ticks only while something is waiting: an action, a state to enter, a sleeping script, an unread event. See [running a game](../guides/running-a-game.md).

## Not done yet

A frame system of the game's own that draws between two ticks works the place out itself, as `Draw` does above, from a velocity or a previous position the simulation keeps: there is no helper for it. [`@arcadekit/three`](../guides/drawing-with-three.md) does it for what it draws, with `smooth: true`.

## Read more

- [`App`](/reference/arcadekit/App) and [`Driver`](/reference/arcadekit/Driver) in the API reference.
- [Input](../guides/input.md), [sound](../guides/sound.md) and [drawing with Three.js](../guides/drawing-with-three.md).
