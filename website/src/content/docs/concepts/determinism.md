---
title: "Determinism"
description: "A tick produces the same result from the same inputs, on every machine and in every JavaScript engine. Saves, replays and online play are built on that guarantee."
---

A tick produces the same result from the same inputs, on every machine and in every JavaScript engine. Saves, replays and online play are all built on that guarantee.

## What determinism gives you

- **Replays.** The app logs every action from outside the simulation. A new app with the same seed, given that log, plays the same game, and verifies itself against the world's hash along the way.
- **Saves.** A save is a snapshot of the world, and the log continues from it. Loading the snapshot and replaying the rest of the log brings the game back to the present.
- **Online play.** Peers exchange only the actions their players issue. Each runs the same simulation, so each ends on the same world.
- **Reproducible tests.** A failing test fails the same way every time, and a bug report is a seed and a log.

## Rules for your simulation

The simulation must not read anything a replay won't have.

| Instead of | Use |
| --- | --- |
| `Date.now()`, `performance.now()`, Effect's `Clock` | `Time`: game time, which advances one fixed step per tick |
| `Math.random()` | `Random`: seeded, with the same numbers on every machine |
| `setTimeout`, `Effect.sleep`, a `Schedule`, a promise | `Script.sleep`, `Script.nextTick`, or an event's `wait` |
| `Effect.forkChild` in a system | `Script.spawn` |
| Reading a key during a tick | An action, issued in the input stage and logged |
| Loading a file during a tick | An action whose payload is the file's contents |
| Playing a sound during a tick | An event, played as a cue in the frame stage |
| Drawing during a tick | A frame-stage system |
| Changing a field between ticks from outside | An action |

- **Randomness.** `const random = yield* Random` gives you the world's generator, whose methods are plain calls, such as `random.next()`. Its state is part of the world, so a replay draws the same numbers. Inside an app, Effect's own `Random` is seeded from it too, at the cost of an Effect per draw. Pass the seed at the entry point, `App.run({ plugins, seed: Date.now() }, ...)`, and everything inside the rules stays reproducible.
- **Waiting.** A timer, a promise, `Effect.sleep` and a `Schedule` all resume outside the tick, at a moment no replay can reproduce. A [script](../guides/scripts.md) waits on game time instead.
- **Fibers.** A fiber started with `Effect.forkChild` in a system is interrupted when the tick's fiber ends. `Script.spawn` starts a script the app supervises: it reports failures, and interrupts the script when its scope closes, which for a plugin's code is when the plugin stops.
- **Ordering.** Don't let the simulation depend on the iteration order of a `Map` or `Set` unless you filled it in a fixed order. Systems run in a fixed order, so the same game runs the same way every time. Two systems that touch the same data produce a different game in a different order, so declare the order that matters with `System.after` or `System.before`. See [systems](../guides/systems.md#ordering).
- **Devices, files, sound and rendering** follow real time, so they live outside the tick, in the input and frame stages. A tick can't tell whether a file was loaded, a sound was heard or a frame was drawn. See [ticks and frames](ticks-and-frames.md).

## Real-time work

An app runs its fibers on its own scheduler, so a fiber resumes only when a tick lets it. Don't provide a different `Scheduler` to code inside an app.

Work that must continue in real time while the game runs, such as loading, runs outside the app's scheduler. A service started in a plugin's `layer`, which is built before the app's scheduler is installed, forks that work with the context it received, using `Effect.context` and then `Effect.runForkWith`, minus the app's own services. Those services belong to the game: inside an app, Effect's `Random` is the world's generator, and real-time code that drew from it would change the game. [Assets](../guides/assets.md) load this way.

## The world's hash

`app.world.hash()` is a single number for everything in the world a simulation can observe: every entity and field, the order queries visit them in, the ids the next entities will get, every singleton that has been written, and the state of the random generator. Two worlds built by the same operations hash the same, and changing one field always changes the hash.

The app records the hash in its log every `checkpointEvery` ticks, 60 by default. A replay compares its own world at each checkpoint and stops at the first mismatch with `App.ReplayDiverged`, which reports the tick and when the two last agreed. [Replays](../guides/replays.md#the-worlds-hash) covers what the hash includes and what it costs.

## Refused actions leave no trace

A refused action isn't in the log, so a replay never runs it, and anything it left in the world would make the replay diverge. That's why a handler runs in a transaction: on refusal, its writes, the random numbers it drew, the commands it queued and the events it emitted are all rolled back. [Events and actions](../guides/events-and-actions.md#checking-and-refusing) lists what isn't rolled back.

## Rendering can't break determinism

The frame stage draws and plays sound while the world is read-only. A drawn game has the same hash, log and save as one that isn't drawn, so a replay or a server runs it without rendering anything.

## What isn't checked

Some ways to break determinism aren't caught by the type checker or at run time:

- A real-time wait, `Effect.sleep` or a promise, resumes outside the tick. Nothing refuses it.
- A fiber started with `Effect.forkDetach` outlives the tick and isn't supervised by the app: its failure is silent unless whoever started it observes it.
- [`Assets.load`](../guides/assets.md) in a script resumes in whatever tick the file arrives in.
- A write through a raw column during the frame or input stage is only detected by an app created with `verifyFrames`.
- A tick reads the devices unless told not to. A tool that re-runs a game from its log by hand passes `app.tick(delta, { input: false })`, as `App.replay` does, or the keys of the machine it runs on leak into the game.
- A script that keeps its progress in its own variables restarts from the beginning when the game is loaded.
- The hash covers only the world: not the events waiting to be read, what change queries haven't visited, queued actions, or how far a script has got. Two games with the same hash can still diverge.

In a multiplayer game, a broken rule is caught quickly: peers compare the hashes of their worlds, and every session stops with `Lockstep.Drifted`, which reports the last tick they agreed on. To test such a game, run two apps side by side and compare their hashes. See [several players](several-players.md).

## Read more

- [Saving and loading](../guides/saving-and-loading.md) and [replays](../guides/replays.md).
- [`Random`](/reference/arcadekit/Services#random) and the world's [`hash`](/reference/arcadekit/ecs#world) in the API reference.
