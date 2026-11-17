# Determinism

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
| `Date.now()`, `performance.now()` | `Time`: the game's time, which passes by one fixed step a tick |
| `Math.random()` | `Random`: seeded, the same numbers on every machine |
| `setTimeout`, `Effect.sleep`, a promise | `Script.sleep`, `Script.nextTick`, or an event's `wait` |
| Reading a key in a tick | An action, issued in the input stage and logged |
| Loading a file in a tick | An action whose payload is what the file held |
| A field changed between ticks from outside | An action |

The seed is given at the entry point, `App.run({ plugins, seed: Date.now() }, ...)`. Everything inside the rules stays repeatable.

Order matters too: two systems that touch the same thing give a different game in another order. A system can say what it reads and writes, and the app then lists the pairs whose order nothing says. See [systems](../guides/systems.md#saying-what-a-system-touches).

## The world's hash

`app.world.hash()` is one number for everything in the world a simulation can tell apart: every entity and field, the order queries visit them in, the ids to come, every singleton that was written, and the state of the random generator. Two worlds built by the same operations hash the same, and one field changed always changes it.

The app records the hash in its log every `checkpointEvery` ticks, 60 unless told. A replay compares its own world at each one and stops at the first that differs, with `App.ReplayDiverged`, which says the tick and when the two last agreed.

## Refusals leave nothing behind

A refused action is not in the log, so a replay never runs it. Anything it left in the world would make the replay differ. So a handler runs in a transaction: what it wrote, the numbers it drew, the commands it queued and the events it emitted are all taken back when it refuses.

## What the frame stage can't break

The frame stage draws and plays sound with the world frozen. A game that is drawn has the same hash, log and save as one that isn't, so a replay or a server runs it without drawing anything.

## What is not checked

Some ways to break determinism aren't caught by the types or at run time: a fiber started with `Effect.forkDetach`, a write through a raw column during the frame stage, a script that keeps its progress in its own variables when the game is loaded. The roadmap keeps the list, under [To revisit before a stable release](../roadmap.md#to-revisit-before-a-stable-release).

## Read more

- [Saving and loading](../guides/saving-and-loading.md) and [replays](../guides/replays.md).
- [Randomness](../../packages/arcadekit/README.md#randomness) and [the world's hash](../../packages/arcadekit/README.md#the-worlds-hash) in the reference.
