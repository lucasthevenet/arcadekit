---
title: "Determinism"
description: "A tick produces the same result from the same inputs, on every machine and in every JavaScript engine. Saves, replays and online play are built on that guarantee."
---

**Determinism** means a tick produces the same result from the same inputs, on every machine and in every JavaScript engine. Saves, replays and online play are all built on that guarantee.

## A seed and a log reproduce a game

- **Replays.** The app logs every action from outside the simulation. A new app with the same seed, given that log, plays the same game, and checks itself against the world's hash along the way.
- **Saves.** A save is a snapshot of the world, and the log goes on from it. Loading the snapshot and replaying the rest of the log brings the game back to the present.
- **Online play.** Peers exchange only the actions their players issue. Each peer runs the same simulation, so each ends on the same world.
- **Reproducible tests.** A failing test fails the same way every time, and a bug report is a seed and a log.

## The simulation reads only what a replay has

The table pairs each thing a simulation can't read with what it reads instead.

| Instead of | Use |
| --- | --- |
| `Date.now()`, `performance.now()`, Effect's `Clock` | `Time`: game time, which advances one fixed step per tick |
| `Math.random()` | `Random`: seeded, with the same numbers on every machine |
| `setTimeout`, `Effect.sleep`, a `Schedule`, a promise | A time left, kept in the world and counted down by a system with `Time` |
| A fiber that outlives its tick | Work kept in the world, which a system moves on each tick |
| Reading a key during a tick | An action, issued in the input stage and logged |
| Loading a file during a tick | An action whose payload is the file's contents |
| Playing a sound during a tick | An event, played as a cue in the frame stage |
| Drawing during a tick | A frame-stage system |
| Changing a field between ticks from outside | An action |

- **Randomness.** `const random = yield* Random` gives the world's generator, whose methods are plain calls, such as `random.next()`. Its state is part of the world, so a replay draws the same numbers. Inside an app, Effect's own `Random` is seeded from it too, at the cost of an Effect per draw. Pass the seed at the entry point, `App.make(game, { seed: Date.now() })`, and everything inside the rules stays reproducible.
- **Waiting.** A timer, a promise, `Effect.sleep` and a `Schedule` all resume outside the tick, at a moment no replay can reproduce. A system that waits throws. Work that takes [many ticks](../guides/systems.md#spread-work-over-many-ticks) keeps its place in the world instead, where a save, a replay and the hash see it.
- **Fibers.** A fiber a system starts ends with the tick. One started with `Effect.forkChild` is interrupted when the tick's fiber ends. One that would outlive the tick, started with `Effect.forkDetach`, `Effect.forkIn` or into a scope of its own, would change the game at a moment no replay repeats. The tick throws once it is over, naming the system that started the fiber. The same holds for a handler, the frame and input stages, and a plugin's `setup`.
- **Ordering.** Don't let the simulation depend on the iteration order of a `Map` or `Set` unless you filled it in a fixed order. Systems run stage by stage, and within a stage in the order they are listed, so the same game runs the same way every time. Two systems that touch the same data produce a different game in a different order. List them in the order that matters, or move one to another stage with `System.inStage`. A list in which one system would react a tick late to another's writes doesn't compile. See [order systems](../guides/systems.md#order-systems).
- **Devices, files, sound and rendering** follow real time, so they run outside the tick, in the input and frame stages. A tick can't tell whether a file was loaded, a sound was heard or a frame was drawn. See [ticks and frames](ticks-and-frames.md).

## Real-time work runs outside the app's scheduler

An app runs its fibers on its own scheduler, so a fiber resumes only when a tick lets it. Don't provide a different `Scheduler` to code inside an app.

Work that must go on in real time while the game runs, such as loading, runs outside the app's scheduler. A plugin's `layer` is built before the app's scheduler is installed. A service the layer starts takes the context it received with `Effect.context`, removes the app's own services with `Context.omit`, and forks its work with `Effect.runForkWith`. The app's services belong to the game. Inside an app, Effect's `Random` is the world's generator, and real-time code that drew from it would change the game. [Assets](../guides/assets.md) load this way.

## The world's hash covers what a simulation can observe

`world.hash()`, on the world that `app.read(World)` gives, is a single integer, from 0 to 2^32 - 1, for everything in the world a simulation can observe. Two machines that ran the same game hold the same number, as does a replay that went the same way. It covers:

- every entity and the value of every field of every component it has, each component identified by its name and its fields;
- the order queries visit entities in: tables in creation order, rows ascending;
- the ids the next entities will get: the freed slots, in reuse order, and their generations;
- every singleton that has been written, by name;
- the game's time: the ticks run, the seconds simulated and the last tick's `delta`, which the world holds as the singleton `arcadekit/Time`;
- the state of the random number generator;
- the actions queued for the next tick, with who issued them, and the events the simulation has yet to read, each in its JSON form.

Two worlds built by the same operations in the same order hash equal. Changing one field of one entity always changes the hash, since one change can't cancel out. Two different worlds collide by chance about once in four billion.

The hash doesn't depend on anything a simulation can't observe: a table's capacity, leftover data in a column past its last row, which queries were created, the order a sparse component's members joined in, or the order the program defined its components in. Every `NaN` counts as the same `NaN`, because engines don't agree on a `NaN`'s bits. `0` and `-0` differ.

- A non-numeric field counts as it is [saved](../guides/saving-and-loading.md#snapshot-a-world): a `json` field as the plain data it holds, a `schema` or `ref` field in its encoded form, and a `transient` field not at all.
- It uses 32-bit integer arithmetic on each field's bits, so it is identical on every machine and in every JavaScript engine.
- It changes nothing in the world, so you can call it at any time. It costs about 8 ns per entity with four float fields.
- It doesn't cover where each reader is: how far a system has read the events, or what change queries haven't visited. Where a reader is belongs to the reader, so a plugin that only watches a game doesn't change the game's hash. Two games with the same hash can still differ there, until the difference reaches the world. A [save](../guides/saving-and-loading.md) holds where each reader is.

The app records the hash in its log every `checkpointEvery` ticks, 60 by default. A replay compares its own world at each checkpoint, and stops at the first mismatch with `Journal.ReplayDiverged`, which reports the tick and when the two last agreed. [Verify a replay with checkpoints](../guides/replays.md#verify-a-replay-with-checkpoints) covers how often to record one, and what it costs.

## Refused actions leave no trace

A refused action isn't in the log, so a replay never runs it. Anything the action left in the world would make the replay diverge. A handler therefore runs in a transaction. On refusal, its writes, the random numbers it drew, the commands it queued and the events it emitted are all rolled back. [Events and actions](../guides/events-and-actions.md#check-and-refuse-an-action) lists what isn't rolled back.

## Rendering can't break determinism

The frame stage draws and plays sound while the world is read-only. A drawn game has the same hash, log and save as one that isn't drawn, so a replay or a server runs it without rendering anything.

## Some breaks are not caught by default

The type checker and the default checks at run time miss these ways to break determinism:

- A write forced through a raw column that `eachChunk` hands out read-only, in any stage, is refused only by an app created with `verifyFrames`.
- State a tick reads from outside the world, in a service, a plugin or a module, isn't put back by a rewind, so a rollback session runs the tick again differently. Only `Session.syncTest` detects it, by running each tick twice from the same moment. See [testing several peers](../guides/testing-peers.md#check-that-a-rewind-runs-the-same).
- The hash doesn't cover [where each reader is](#the-worlds-hash-covers-what-a-simulation-can-observe), so two games with the same hash can still diverge.

In a multiplayer game, a broken rule is caught at the first checkpoint after it changes the world. Peers compare the hashes of their worlds, and every session stops with `Drift.Drifted`, which reports the last tick they agreed on. To test such a game, run two peers side by side and compare their hashes, as [testing several peers](../guides/testing-peers.md#connect-several-peers) shows.

## Read more

- [Saving and loading](../guides/saving-and-loading.md) and [replays](../guides/replays.md).
- [`Random`](/reference/arcadekit/Services#random) and the world's [`hash`](/reference/arcadekit/ecs#world) in the API reference.
