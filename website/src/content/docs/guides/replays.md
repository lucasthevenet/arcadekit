---
title: "Replays"
description: "A game that changes only by its actions, its systems and its seed can be played again from its log."
---

A game that changes only by its actions, its systems and its seed can be played again from its log. A replay checks itself as it goes, so a game that has stopped being deterministic is caught at the tick it went another way.

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
  components: [Score],
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
  const text = Action.encodeLog(game.actionLog); // for a file

  const log = yield* Action.decodeLog(text); // fails on text that is not a log
  const again = yield* App.make({
    plugins: [Rules],
    seed: 42,
    checkpointEvery: 1,
  });
  App.replay(again, log, { delta: 1 / 60, ticks: 10 }); // throws App.ReplayDiverged
}).pipe(Effect.scoped);
```

`app.actionLog` holds what came into the game from outside, in the order it came, each with its payload in JSON form and the tick it arrived at:

- every dispatched action that was accepted;
- every action enqueued through the app, marked `queued`, and marked `refused`, with the reason in a few words, if it was refused when its turn came;
- checkpoints, the world's hash at a tick. `Action.isCheckpoint(entry)` tells the two kinds of entry apart.

`App.replay(app, log, { delta, ticks })` plays the log into a fresh app made with the same plugins and seed, and started from the same state: what was spawned into `app.world` before the first action or tick. It is told the tick length and how many ticks the game ran: the log doesn't say.

## Checkpoints

The app records a checkpoint before the first action or tick, then at the end of every tick whose number divides by `checkpointEvery`. `app.checkpoint()` records one more, for a moment the game wants checked, such as when it is saved.

A replay compares its own world at each checkpoint, and stops at the first that differs, before applying anything recorded after it. It throws `App.ReplayDiverged`, whose `tick` is that checkpoint's. Its `reason` is an `App.HashMismatch` with the `expected` hash, the `actual` one, and `agreedAt`, the tick of the last checkpoint that matched. With a checkpoint every tick, `tick` is the tick the replay diverged on.

- `checkpointEvery` is 60 unless told. A checkpoint costs one hash of the world, 0.8 ms for 100,000 entities, and adds an entry to the log. A smaller number finds a divergence closer to where it happened, at that price. A turn-based game, which ticks once a move, wants 1.
- With 0 the app records none, and a replay has only its actions to check itself by. One that has gone wrong runs on until an action happens to be refused, and one whose fault broke no rule runs to its end and gives another game.
- A replay made with another seed, or into a world that doesn't hold what the game's held, stops before its first tick.
- A dispatched action that the replay refuses, where the game accepted it, stops the replay too, with the refusal as the `reason`.
- An enqueued action is enqueued again at the point it arrived, so it takes its turn among the actions the replay's own simulation issues. If the replay refuses what the game accepted, or the other way round, it stops after the tick that applied it.

## The world's hash

`app.world.hash()` is one whole number, from 0 to 2^32 - 1, for everything in the world that a simulation can tell apart. Two machines that have run the same game hold the same number, and a replay that has gone the same way does too. It covers:

- every entity and the value of every field of every component it has, a component being known by its name and its fields;
- the order queries visit entities in: tables in creation order, rows ascending;
- the ids the next entities will get: the freed slots, in the order they will be reused, and their generations;
- every singleton that has been written, by name;
- the state of the random number generator.

So two worlds built by the same operations in the same order hash equal, and changing one field of one entity always changes the hash: a single change can't cancel out. Two different worlds hash equal by chance about once in four billion.

It doesn't depend on what can't be told apart: how much room a table has, what is left in a column past its last row, which queries have been made, the order a sparse component's members joined in, or the order the program defined its components in. Every NaN counts as the same NaN, because its bits are the one thing engines don't agree on. 0 and -0 are different.

- A field that isn't a number counts as it is [saved](saving-and-loading.md#snapshots-on-their-own): a `json` field as the plain data it holds, a `schema` or `ref` field in its encoded form, and a `transient` field not at all.
- It is 32-bit integer arithmetic on the bits of each field, so it is the same on every machine and in every JavaScript engine.
- It reads and changes nothing, so it can be called at any time. It costs about 8 ns per entity for four float fields.
- It is of the world only: not the events waiting to be read, what change queries have yet to visit, the actions queued, or how far a script has got. Two games with the same hash can still go different ways. A [save](saving-and-loading.md) holds all of those but the scripts.

## What a replay doesn't do

- It runs no frame stage and no input stage: it reads no device and draws nothing. `App.replay` ticks with `{ input: false }`. A tool that replays by hand with `tick` says the same, or the machine's own keys join in.
- What the simulation issues itself, a bot's move, isn't in the log: the replay's own systems issue it again.
- Once a game has started, what changes its world has to be in the log or come from the simulation: an action, a system, a script. A coin spawned into `app.world` by hand between two ticks is in neither. The replay can't know of it, and stops at the next checkpoint.
- A script started by hand with `app.spawnScript` isn't in the log. Whoever replays starts it again, at the same tick. A plugin's `scripts` start with the replay's app as they did with the game's.
- A write through a raw column in the frame stage or the input stage changes the game with no error, unless the app was made with `verifyFrames`. A replay runs neither stage, so it goes another way. See [testing](testing.md).

## Read more

- [`App`](/reference/arcadekit/App) and [`Action`](/reference/arcadekit/Action) in the API reference, and the world's [`hash`](/reference/arcadekit/ecs#world).
- [Determinism](../concepts/determinism.md), for what a game must not do.
