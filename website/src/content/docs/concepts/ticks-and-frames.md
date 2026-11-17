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

A frame draws the game as it is. The world is frozen while it runs: anything that would change the game throws where it is made and says why. A frame system can read every query, singleton and event, and it is told how far the frame is between two ticks, `Frame.alpha`, so it can draw a moving thing between its last place and its next.

This is the rule that makes the rest work: **a game that is drawn is the same game as one that is not.** A replay or a server runs no frame stage at all, and ends on the same world.

Sound is played from the frame stage too, from the events the ticks emitted. The simulation never plays a sound.

## The input stage

The keyboard, the pointer and the gamepads are outside the game. Once before each tick, the input stage reads them once, and its systems turn what they say into the game's own actions: `Fire`, `Jump`, `Move`. Those actions are logged and applied at the start of the tick.

So a replay reads no device: what the devices said is in the log, as actions.

## What drives them

- **`App.run`** makes the app and runs it until it is interrupted: the ticks that are due each repaint, at a fixed `hz`, then the frame. In a page that is `requestAnimationFrame`; under Node it is a timer.
- **`app.tick(delta)`** runs one tick by hand, for a test or a game that steps itself. `app.frame(alpha, delta)` runs the frame stage.
- **`Driver.fixedStep`** runs the ticks that are due for a given amount of real time, then the frame.

A game of turns, a puzzle or a menu has nothing to do between moves. With `ticks: "whenNeeded"`, `App.run` still draws every frame but ticks only while something is waiting: an action, a state to enter, a sleeping script, an unread event. See [running a game](../guides/running-a-game.md).

## Read more

- [The tick and the frame](/reference/arcadekit#the-tick-and-the-frame) in the reference.
- [Input](../guides/input.md), [sound](../guides/sound.md) and [drawing with Three.js](../guides/drawing-with-three.md).
