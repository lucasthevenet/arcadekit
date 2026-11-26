---
title: "Replays"
description: "A game that changes only through its actions, its systems and its seed can be replayed from its log. A replay verifies itself, and reports the tick where a game stopped being deterministic."
---

A **replay** plays a game again from its log. A game that changes only through its actions, its systems and its seed can be replayed. A replay checks itself as it runs, so it catches a game that stopped being deterministic at the first checkpoint after it diverged, and at the latest where the recording ends.

## Record a game and play it back

```ts
import { Action, App, Field, Journal, Plugin, Singleton } from "arcadekit";
import { Effect, Schema } from "effect";

const Score = Singleton.define(
  "game/Score",
  { points: Field.i32 },
  { points: 0 }
);
const Add = Action.define("game/Add", Schema.Struct({ points: Schema.Int }));
const add = Action.handler(Add, function* ({ points }) {
  (yield* Score.writes).points += points;
});
const Rules = Plugin.make("game/Rules", {
  handlers: [add],
});
const Game = App.define({ plugins: [Rules] });

const program = Effect.gen(function* () {
  const game = yield* Effect.acquireRelease(
    App.make(Game, { seed: 42, checkpointEvery: 1 }),
    (app) => app.close
  );
  yield* game.enqueue(Add, { points: 3 });
  for (let i = 0; i < 10; i++) {
    yield* game.tick(1 / 60);
  }
  const bytes = yield* Journal.encode(yield* game.record()); // for a file

  const recording = yield* Journal.decode(bytes); // fails with Journal.Invalid on bytes that aren't one
  // The replay makes its app from how the recorded game began: its seed.
  const again = yield* Effect.acquireRelease(
    Journal.replay(recording, Game, { checkpointEvery: 1 }), // fails with Journal.ReplayDiverged
    (app) => app.close
  );
}).pipe(Effect.scoped);
```

`app.actionLog` holds everything that entered the game from outside, in arrival order:

- every dispatched action that was accepted;
- every action enqueued through the app, marked `queued`, and also marked `refused`, with a short reason, if it was refused when its turn came;
- checkpoints, each the world's hash at a tick. `Action.isCheckpoint(entry)` tells the two kinds of entry apart.

Each action holds its payload in JSON form and the tick it arrived at. Actions the simulation issues itself, such as a bot's move, aren't in the log, since the replay's own systems issue them again.

`app.record()` gives a recording: how the game began, that log, the ticks it begins and ends at, the `delta` of every tick in between, kept as runs of ticks that took the same delta, and `endHash`, the world's hash where it ends. How the game began is its `seed`, or the `save` it was recorded since, in the words `App.make` takes. A recording comes only from `app.record()` or `Journal.decode`: an object written by hand isn't one, and doesn't compile as one. To replay an edited recording, edit its bytes and decode them.

`Journal.replay(recording, game)` makes an app of the game from how the recorded game began, plays the recording in it, and returns the app where the recording ends.

- It takes no seed and no save, so a replay begins as the recorded game did. It also starts from the same state, since a game starts with what its plugins' `setup` spawns, and code outside the game can't spawn anything.
- Each tick takes the delta it took when recorded, up to the recording's last tick, so a replay can't be given the wrong tick length or stop short.
- A third argument gives the replay's app the rest of what `App.make` takes, such as `{ checkpointEvery: 1 }`.
- The app it returns belongs to the caller, as one that `App.make` makes does. Close it when you are done with it.
- It runs no frame or input stage, so it reads no device and draws nothing. What the devices said is in the log.
- In the recorded game, a frame or input stage that wrote through a raw column changed the game with no error, unless the app was made with `verifyFrames`, which refuses the write. The replay runs neither stage, so it diverges. See [testing](testing.md#run-the-frame-stage-by-hand).

`Journal.encode` turns a recording into bytes, and `Journal.decode` turns the bytes back. `Journal.decode` refuses a recording that doesn't say how its game began, one whose save doesn't read or is of another tick than the recording begins at, and one whose log or runs of deltas are out of order or outside it. It refuses a recording that an earlier version of arcadekit wrote as text. A recording made since a save holds the save, as the bytes `Save.encode` writes, which are most of it.

## Verify a replay with checkpoints

A **checkpoint** is the [world's hash](../concepts/determinism.md#the-worlds-hash-covers-what-a-simulation-can-observe) at a tick, recorded in the log. The app records one before the first action or tick, then at the end of every tick whose number is a multiple of `checkpointEvery`. `app.checkpoint()` records one more, for a moment the game wants checked, such as a save.

A replay compares its own world at each checkpoint, and stops at the first mismatch, before applying anything recorded after it. It fails with `Journal.ReplayDiverged`, whose `tick` is that checkpoint's tick. Its `reason` is a `Journal.HashMismatch` with the `expected` hash, the `actual` one, and `agreedAt`, the tick of the last matching checkpoint. With a checkpoint every tick, `tick` is the exact tick the replay diverged on.

Once it has played the last tick, the replay compares its world with the recording's `endHash` in the same way. A mismatch there fails with a `ReplayDiverged` whose `entry` is a checkpoint of the recording's `end` and `endHash`, and whose `index` is the log's length. So a replay that succeeds ended on the world the recorded game ended on, whatever `checkpointEvery` was. `checkpointEvery` says only how often the replay checks along the way.

| Option | Default | What it does |
| --- | --- | --- |
| `checkpointEvery` | `60` | Records a checkpoint at the end of every tick whose number is a multiple of it. `0` records none |

- A checkpoint costs one hash of the world, 0.8 ms for 100,000 entities, and one log entry. A smaller value catches divergence closer to where it happened, at that cost. A turn-based game, which ticks once per move, wants 1.
- With 0, a replay checks itself along the way only against its actions. A replay that has gone wrong runs until an action happens to be refused, or to the end, and fails there on the `endHash`. It can't say on which tick it went wrong.
- A replay whose world doesn't start as the recorded game's did stops before its first tick. A seed edited in the recording does this, and so does a setup that spawns something else.
- A dispatched action that the replay refuses, where the game accepted it, also stops the replay, with the refusal as the `reason`.
- An enqueued action is enqueued again at the point it arrived, so it takes its turn among the actions the replay's own simulation issues. If the replay refuses what the game accepted, or the other way round, it stops after the tick that applied it.

```ts sketch
yield* Journal.replay(recording, Game).pipe(
  Effect.catchTag("JournalReplayDiverged", (diverged) =>
    Effect.map(diverged.app.read(World), (world) => /* … */)
  )
);
```

Whatever stops a replay, the error's `app` is the replay's app where it stopped. The replay has closed that app, but its world, its log and its time are still there to read.

## Read more

- [`Journal`](/reference/arcadekit/Journal), [`App`](/reference/arcadekit/App) and [`Action`](/reference/arcadekit/Action) in the API reference, and the world's [`hash`](/reference/arcadekit/ecs#world).
- [Determinism](../concepts/determinism.md), for what your game must avoid.
