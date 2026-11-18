---
title: "Determinism"
description: "A tick gives the same result from the same inputs, on every machine and in every JavaScript engine. Saves, replays and network play all stand on that."
---

A tick gives the same result from the same inputs, on every machine and in every JavaScript engine. Saves, replays and network play all stand on that.

## What it buys

- **Replays.** The app logs every action that came from outside. A new app with the same seed, given that log, plays the same game, and checks itself against the world's hash as it goes.
- **Saves.** A save is a snapshot of the world plus the log since. Loading the snapshot and replaying the tail brings the game back to the present.
- **Several players.** Peers send each other only the actions their players issue. Each runs the same simulation, so each ends on the same world.
- **Tests that repeat.** A failing test fails the same way every time, and a bug is a seed and a log.

## What a game must do

The simulation reads nothing the replay won't have.

| Instead of | Use |
| --- | --- |
| `Date.now()`, `performance.now()`, Effect's `Clock` | `Time`: the game's time, which passes by one fixed step a tick |
| `Math.random()` | `Random`: seeded, the same numbers on every machine |
| `setTimeout`, `Effect.sleep`, a `Schedule`, a promise | `Script.sleep`, `Script.nextTick`, or an event's `wait` |
| `Effect.forkChild` in a system | `Script.spawn` |
| Reading a key in a tick | An action, issued in the input stage and logged |
| Loading a file in a tick | An action whose payload is what the file held |
| Playing a sound in a tick | An event, which a cue of the frame stage plays |
| Drawing in a tick | A system of the frame stage |
| A field changed between ticks from outside | An action |

- **Randomness.** `const random = yield* Random` gives the world's generator, and its methods are plain calls, such as `random.next()`. Its state is in the world, so a replay draws the same numbers. Inside an app Effect's own `Random` is seeded from it too, at the cost of an Effect per draw. The seed is given at the entry point, `App.run({ plugins, seed: Date.now() }, ...)`. Everything inside the rules stays repeatable.
- **Waiting.** A timer, a promise, `Effect.sleep` and a `Schedule` all resume outside the tick, at a moment no replay repeats. A [script](../guides/scripts.md) waits on the game's time.
- **Fibers.** A child started with `Effect.forkChild` in a system is interrupted when the tick's fiber ends. `Script.spawn` starts a script the app watches: it reports a failure, and interrupts the script when its scope closes.
- **Order.** The simulation doesn't depend on the order of a `Map` or a `Set` it didn't fill itself in a fixed order. And two systems that touch the same thing give a different game in another order: a system can say what it reads and writes, and the app then lists the pairs whose order nothing says. See [systems](../guides/systems.md#saying-what-a-system-touches).
- **Devices, files, sound and drawing** follow real time, so they are outside the tick: in the input stage and the frame stage. A tick can't tell whether a file was loaded, a sound was heard or a frame was drawn. See [ticks and frames](ticks-and-frames.md).

## What runs in real time

An app runs its fibers on a scheduler of its own, so a fiber resumes only when a tick lets it. Don't provide another `Scheduler` to code inside an app.

What has to go on in real time while the game runs, as loading does, is not code inside the app. A service started in a plugin's `layer`, which is built before the app's scheduler is in place, forks it with the context it found there, `Effect.context` and then `Effect.runForkWith`, less the app's own services. Those are the game's: inside an app Effect's `Random` is the world's generator, and whatever runs in real time and draws from it has changed the game. [Assets](../guides/assets.md) are loaded that way.

## The world's hash

`app.world.hash()` is one number for everything in the world a simulation can tell apart: every entity and field, the order queries visit them in, the ids to come, every singleton that was written, and the state of the random generator. Two worlds built by the same operations hash the same, and one field changed always changes it.

The app records the hash in its log every `checkpointEvery` ticks, 60 unless told. A replay compares its own world at each one and stops at the first that differs, with `App.ReplayDiverged`, which says the tick and when the two last agreed. [Replays](../guides/replays.md#the-worlds-hash) says what the hash covers and what it costs.

## Refusals leave nothing behind

A refused action is not in the log, so a replay never runs it. Anything it left in the world would make the replay differ. So a handler runs in a transaction: what it wrote, the numbers it drew, the commands it queued and the events it emitted are all taken back when it refuses. [Events and actions](../guides/events-and-actions.md#checking-and-refusing) says what is not taken back.

## What the frame stage can't break

The frame stage draws and plays sound with the world frozen. A game that is drawn has the same hash, log and save as one that isn't, so a replay or a server runs it without drawing anything.

## What is not checked

Some ways to break determinism aren't caught by the types or at run time:

- A wait in real time, `Effect.sleep` or a promise, resumes outside the tick. Nothing refuses it.
- A fiber started with `Effect.forkDetach` outlives the tick, and the app doesn't watch it: its failure is silent unless whoever started it looks.
- [`Assets.load`](../guides/assets.md) in a script resumes in whatever tick the file arrives in.
- A write through a raw column during the frame stage or the input stage is found only by an app made with `verifyFrames`.
- A tick reads the devices unless it is told not to. A tool that runs a game again from its log by hand says `app.tick(delta, { input: false })`, as `App.replay` does, or the keys of the machine it runs on join in.
- A script that keeps its progress in its own variables starts over when the game is loaded.
- The hash is of the world only: not the events waiting to be read, what a change query has yet to visit, the actions queued, or how far a script has got. Two games with the same hash can still go different ways.

In a game of several peers a break of these rules doesn't go unnoticed for long: the peers compare the hashes of their worlds, and a session stops with `Lockstep.Drifted`, which says the tick they last agreed at. A test of such a game runs two apps of it side by side and compares their hashes. See [several players](several-players.md).

## Read more

- [Saving and loading](../guides/saving-and-loading.md) and [replays](../guides/replays.md).
- [`Random`](/reference/arcadekit/Services#random) and the world's [`hash`](/reference/arcadekit/ecs#world) in the API reference.
