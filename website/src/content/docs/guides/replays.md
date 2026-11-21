---
title: "Replays"
description: "A game that changes only through its actions, its systems and its seed can be replayed from its log. A replay verifies itself, and reports the tick where a game stopped being deterministic."
---

A game that changes only through its actions, its systems and its seed can be replayed from its log. A **replay** verifies itself as it runs, so a game that stopped being deterministic is caught at the tick it diverged.

## Recording and playing back

```ts
import { Action, App, Plugin, Singleton, Field } from "arcadekit";
import { Effect, Schema } from "effect";

const Score = Singleton.define(
  "game/Score",
  { points: Field.i32 },
  { points: 0 }
);
const Add = Action.define("game/Add", Schema.Struct({ points: Schema.Int }));
const add = Action.handler(Add, function* ({ points }) {
  (yield* Score).points += points;
});
const Rules = Plugin.make("game/Rules", {
  handlers: [add],
});

const program = Effect.gen(function* () {
  const game = yield* App.make({
    plugins: [Rules],
    seed: 42,
    checkpointEvery: 1,
  });
  game.enqueue(Add, { points: 3 });
  for (let i = 0; i < 10; i++) {
    game.tick(1 / 60);
  }
  const text = App.encodeRecording(game.record()); // for a file

  const recording = yield* App.decodeRecording(text); // fails on text that isn't one
  const again = yield* App.make({
    plugins: [Rules],
    seed: 42,
    checkpointEvery: 1,
  });
  App.replay(again, recording); // throws App.ReplayDiverged
}).pipe(Effect.scoped);
```

`app.actionLog` holds everything that entered the game from outside, in arrival order, each entry with its payload in JSON form and the tick it arrived at:

- every dispatched action that was accepted;
- every action enqueued through the app, marked `queued`, and also marked `refused`, with a short reason, if it was refused when its turn came;
- checkpoints, the world's hash at a given tick. `Action.isCheckpoint(entry)` distinguishes the two kinds of entry.

`app.record()` returns a recording: that log, the ticks it begins and ends at, and the `delta` of every tick in between, kept as runs of ticks that took the same delta. `App.replay(app, recording)` plays it into a fresh app created with the same plugins and seed, and started from the same state: whatever was spawned into `app.world` before the first action or tick. Each tick takes the delta it took when it was recorded, up to the tick the recording ends at, so a replay can't be given the wrong tick length or stop short. A replay into an app that isn't at the recording's first tick throws. `App.encodeRecording` and `App.decodeRecording` turn a recording into text and back, and decoding refuses one whose log or runs of deltas are out of order or outside it.

## Checkpoints

The app records a checkpoint before the first action or tick, then at the end of every tick whose number is a multiple of `checkpointEvery`. `app.checkpoint()` records an extra one, for a moment the game wants verified, such as when it is saved.

A replay compares its own world at each checkpoint, and stops at the first mismatch, before applying anything recorded after it. It throws `App.ReplayDiverged`, whose `tick` is that checkpoint's tick. Its `reason` is an `App.HashMismatch` with the `expected` hash, the `actual` one, and `agreedAt`, the tick of the last matching checkpoint. With a checkpoint every tick, `tick` is the exact tick the replay diverged on.

- `checkpointEvery` defaults to 60. A checkpoint costs one hash of the world, 0.8 ms for 100,000 entities, plus one log entry. A smaller value catches divergence closer to where it happened, at that cost. A turn-based game, which ticks once per move, wants 1.
- With 0, the app records no checkpoints, and a replay can only check itself against its actions. A replay that has gone wrong continues until an action happens to be refused, or, if the fault broke no rule, runs to the end and produces a different game.
- A replay with a different seed, or into a world that doesn't start with what the game's held, stops before its first tick.
- A dispatched action the replay refuses, where the game accepted it, also stops the replay, with the refusal as the `reason`.
- An enqueued action is enqueued again at the point it arrived, so it takes its turn among the actions the replay's own simulation issues. If the replay refuses what the game accepted, or the other way round, it stops after the tick that applied it.

## The world's hash

`app.world.hash()` is a single integer, from 0 to 2^32 - 1, for everything in the world a simulation can observe. Two machines that ran the same game hold the same number, as does a replay that went the same way. It covers:

- every entity and the value of every field of every component it has, components being identified by name and fields;
- the order queries visit entities in: tables in creation order, rows ascending;
- the ids the next entities will get: the freed slots, in reuse order, and their generations;
- every singleton that has been written, by name;
- the game's time: the ticks run, the seconds simulated and the last tick's `delta`, which the world holds as the singleton `arcadekit/Time`;
- the state of the random number generator.

Two worlds built by the same operations in the same order hash equal, and changing a single field of a single entity always changes the hash: one change can't cancel out. Two different worlds collide by chance about once in four billion.

It doesn't depend on anything a simulation can't observe: a table's capacity, leftover data in a column past its last row, which queries were created, the order a sparse component's members joined in, or the order the program defined its components in. Every `NaN` counts as the same `NaN`, because its bits are the one thing engines don't agree on. `0` and `-0` differ.

- A non-numeric field counts as it is [saved](saving-and-loading.md#snapshots): a `json` field as the plain data it holds, a `schema` or `ref` field in its encoded form, and a `transient` field not at all.
- It uses 32-bit integer arithmetic on each field's bits, so it is identical on every machine and in every JavaScript engine.
- It reads and changes nothing, so you can call it at any time. It costs about 8 ns per entity with four float fields.
- It covers only the world: not the events waiting to be read, what change queries haven't visited, or queued actions. Two games with the same hash can still diverge. A [save](saving-and-loading.md) holds all of these.

## What a replay doesn't do

- It runs no frame or input stage: it reads no device and draws nothing. `App.replay` ticks with `{ input: false }`, and a tool that replays by hand with `tick` must do the same, or the machine's own keys leak into the game.
- Actions the simulation issues itself, such as a bot's move, aren't in the log: the replay's own systems issue them again.
- Once a game has started, every change to its world must be in the log or come from the simulation: an action, a system, a handler. A coin spawned into `app.world` by hand between two ticks is in neither, so the replay can't reproduce it, and stops at the next checkpoint.
- A write through a raw column in the frame or input stage changes the game without an error, unless the app was created with `verifyFrames`. A replay runs neither stage, so it diverges. See [testing](testing.md).

## Read more

- [`App`](/reference/arcadekit/App) and [`Action`](/reference/arcadekit/Action) in the API reference, and the world's [`hash`](/reference/arcadekit/ecs#world).
- [Determinism](../concepts/determinism.md), for what your game must avoid.
