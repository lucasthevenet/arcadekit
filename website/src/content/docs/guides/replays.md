---
title: "Replays"
description: "A game that changes only through its actions, its systems and its seed can be replayed from its log. A replay verifies itself, and reports the tick where a game stopped being deterministic."
---

A **replay** plays a game again from its log. A game that changes only through its actions, its systems and its seed can be replayed. A replay checks itself as it runs, so it catches a game that stopped being deterministic at the first hash check after it diverged, and at the latest where the recording ends. A person can watch one too, at its own pace.

## Record a game and play it back

```ts
import { Action, App, Field, Plugin, Replay, Singleton } from "arcadekit";
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
    App.make(Game, { seed: 42, hashEvery: 1 }),
    (app) => app.close
  );
  yield* game.enqueue(Add, { points: 3 });
  for (let i = 0; i < 10; i++) {
    yield* game.tick(1 / 60);
  }
  const bytes = yield* Replay.encode(yield* Replay.record(game)); // for a file

  const recording = yield* Replay.decode(bytes); // fails with Replay.Invalid on bytes that aren't one
  // The replay makes its app from how the recorded game began: its seed.
  const again = yield* Effect.acquireRelease(
    Replay.verify(recording, Game, { hashEvery: 1 }), // fails with Replay.Diverged
    (app) => app.close
  );
}).pipe(Effect.scoped);
```

`app.actionLog` holds everything that entered the game from outside, in arrival order:

- every dispatched action that was accepted;
- every action enqueued through the app, marked `queued`, and also marked `refused`, with a short reason, if it was refused when its turn came;
- hash checks, each the world's hash at a tick. `Action.isHashCheck(entry)` tells the two kinds of entry apart.

Each action holds its payload in JSON form and the tick it arrived at. Actions the simulation issues itself, such as a bot's move, aren't in the log, since the replay's own systems issue them again.

`Replay.record(app)` gives a recording: how the game began, that log, the ticks it begins and ends at, the `delta` of every tick in between, kept as runs of ticks that took the same delta, and `endHash`, the world's hash where it ends. How the game began is its `seed`, or the `save` it was recorded since, in the words `App.make` takes. A recording comes only from `Replay.record(app)` or `Replay.decode`: an object written by hand isn't one, and doesn't compile as one. To replay an edited recording, edit its bytes and decode them.

`Replay.verify(recording, game)` makes an app of the game from how the recorded game began, plays the recording in it, and returns the app where the recording ends.

- It takes no seed and no save, so a replay begins as the recorded game did. It also starts from the same state, since a game starts with what its plugins' `setup` spawns, and code outside the game can't spawn anything.
- Each tick takes the delta it took when recorded, up to the recording's last tick, so a replay can't be given the wrong tick length or stop short.
- A third argument gives the replay's app the rest of what `App.make` takes, such as `{ hashEvery: 1 }`.
- The app it returns belongs to the caller, as one that `App.make` makes does. Close it when you are done with it.
- It runs no frame or input stage, so it reads no device and draws nothing. What the devices said is in the log.
- In the recorded game, a frame or input stage that wrote through a raw column changed the game with no error, unless the app was made with `verifyFrames`, which refuses the write. The replay runs neither stage, so it diverges. See [testing](testing.md#run-the-frame-stage-by-hand).

`Replay.encode` turns a recording into bytes, and `Replay.decode` turns the bytes back. `Replay.decode` refuses a recording that doesn't say how its game began, one whose save doesn't read or is of another tick than the recording begins at, and one whose log or runs of deltas are out of order or outside it. It refuses a recording that an earlier version of arcadekit wrote as text. A recording made since a save holds the save, as the bytes `Save.encode` writes, which are most of it.

## Watch a recording

```ts
import { App, Driver, Plugin, Replay } from "arcadekit";
import { Browser } from "arcadekit/browser";
import { Effect } from "effect";

const Game = App.define({ plugins: [Plugin.make("game/Game", {})] });
const button = (id: string) => document.querySelector<HTMLElement>(id)!;
const slider = document.querySelector<HTMLInputElement>("#at")!;

const watch = (bytes: Uint8Array) =>
  Effect.flatMap(Replay.decode(bytes), (recording) =>
    Driver.run(Replay.play(recording, Game), {
      ready: (player) =>
        Effect.sync(() => {
          // Each control runs an Effect of its own, between two frames.
          button("#pause").onclick = () => Effect.runFork(player.pause);
          button("#play").onclick = () => Effect.runFork(player.play());
          button("#fast").onclick = () => Effect.runFork(player.play(4));
          slider.max = String(recording.end);
          slider.oninput = () =>
            Effect.runFork(player.seek(Number(slider.value)));
        }),
    })
  );

Browser.runMain(watch(new Uint8Array()), {
  target: document.querySelector("canvas")!,
});
```

`Replay.play(recording, game)` makes a **player**: the app of the game made from how the recorded game began, which a driver steps a recorded tick at a time, at the recording's own pace, and whose frame stage draws it. `Driver.run` runs it as it runs a session, and closes it when it ends. A kill-cam, a spectator's view, a replay a player watches and a tool that scrubs through a bug are each a player.

- `player.pause` stops it where it is, and the driver goes on drawing it there. `player.play(rate)` plays on, at `rate` of the recording's ticks for each of the driver's: 1 by default, 2 twice as fast, 0.5 half as fast.
- `player.seek(tick)` goes to a tick, forward or back. The frame stage draws the game there, and hears nothing of the ticks it went past, so no sound of them plays. The player keeps the game every 60 ticks, and a seek back goes to the nearest of those before the tick and plays on from there.
- `player.app` is the app it plays in, to read, and `player.app.time.tick` where it is. At the end it stands still, and `player.ended` is true once it has ended on the recording's hash.
- It checks itself as `Replay.verify` does. A tick that doesn't replay as it was recorded fails with `Replay.Diverged`, which stops the driver.
- It runs no input stage: the log holds what the devices said.

## Verify a replay with hash checks

A **hash check** is the [world's hash](../concepts/determinism.md#the-worlds-hash-covers-what-a-simulation-can-observe) at a tick, recorded in the log. The app records one before the first action or tick, then at the end of every tick whose number is a multiple of `hashEvery`. `Replay.hashCheck(app)` records one more, for a moment the game wants checked, such as a save.

A replay compares its own world at each hash check, and stops at the first mismatch, before applying anything recorded after it. It fails with `Replay.Diverged`, whose `tick` is that hash check's tick. Its `reason` is a `Replay.HashMismatch` with the `expected` hash, the `actual` one, and `agreedAt`, the tick of the last matching hash check. With a hash check every tick, `tick` is the exact tick the replay diverged on.

Once it has played the last tick, the replay compares its world with the recording's `endHash` in the same way. A mismatch there fails with a `Replay.Diverged` whose `entry` is a hash check of the recording's `end` and `endHash`, and whose `index` is the log's length. So a replay that succeeds ended on the world the recorded game ended on, whatever `hashEvery` was. `hashEvery` says only how often the replay checks along the way.

| Option | Default | What it does |
| --- | --- | --- |
| `hashEvery` | `60` | Records a hash check at the end of every tick whose number is a multiple of it. `0` records none |

- A hash check costs one hash of the world, 0.8 ms for 100,000 entities, and one log entry. A smaller value catches divergence closer to where it happened, at that cost. A turn-based game, which ticks once per move, wants 1.
- With 0, a replay checks itself along the way only against its actions. A replay that has gone wrong runs until an action happens to be refused, or to the end, and fails there on the `endHash`. It can't say on which tick it went wrong.
- A replay whose world doesn't start as the recorded game's did stops before its first tick. A seed edited in the recording does this, and so does a setup that spawns something else.
- A dispatched action that the replay refuses, where the game accepted it, also stops the replay, with the refusal as the `reason`.
- An enqueued action is enqueued again at the point it arrived, so it takes its turn among the actions the replay's own simulation issues. If the replay refuses what the game accepted, or the other way round, it stops after the tick that applied it.

```ts sketch
yield* Replay.verify(recording, Game).pipe(
  Effect.catchTag("ReplayDiverged", (diverged) =>
    Effect.map(diverged.app.read(World), (world) => /* … */)
  )
);
```

Whatever stops a replay, the error's `app` is the replay's app where it stopped. The replay has closed that app, but its world, its log and its time are still there to read.

## Compare two games

The world has two hashes. `world.hash()` covers everything a simulation can tell apart, the game's time included: a hash check, a replay's `endHash`, a session's check for [drift](detecting-drift.md) and a lobby compare it. `world.hash({ time: false })` covers the same but the game's time, `Time`, which every tick moves on. A test that pauses a game compares that one:

```ts title="pause.test.ts"
import { expect, it } from "@effect/vitest";
import {
  Action,
  App,
  Commands,
  Component,
  Field,
  Plugin,
  Query,
  State,
  System,
  Test,
  World,
} from "arcadekit";
import { Effect, Schema } from "effect";

const Phase = State.define("game/Phase", ["playing", "paused"]);
const Ball = Component.define("game/Ball", { x: Field.f32 });
const Balls = Query.all(Ball).pipe(Query.writes(Ball));

const Roll = System.tick("game/Roll", function* () {
  (yield* Balls).each((ball) => {
    ball.x += 1;
  });
}).pipe(System.runIf(State.is(Phase, "playing")));

const Pause = Action.define("game/Pause", Schema.Struct({}));
const pause = Action.handler(Pause, function* () {
  (yield* Phase.sets).set("paused");
});

const Rules = Plugin.make("game/Rules", {
  systems: [Roll],
  handlers: [pause],
  setup: Effect.gen(function* () {
    (yield* Commands.spawns(Ball)).spawn(Ball);
  }),
});

it.effect("stands still while paused", () =>
  Effect.gen(function* () {
    const game = yield* Test.make(App.define({ plugins: [Rules] }));
    yield* game.app.enqueue(Pause, {});
    yield* game.step();
    const world = yield* game.app.read(World);
    const [still, all] = [world.hash({ time: false }), world.hash()];
    for (let i = 0; i < 120; i++) {
      yield* game.step();
    }
    expect(world.hash({ time: false })).toBe(still);
    expect(world.hash()).not.toBe(all); // 120 ticks later
  })
);
```

- A game and a replay of it, two peers, and a game and its save loaded and played on the same way, hash the same with `world.hash()`. Compare that one when they ran the same ticks.
- A save holds whether the game was at rest. An app made from a save of a game that [ticks only when needed](running-a-game.md#tick-only-when-needed), taken at rest, or that loads it with `Save.load`, runs no tick before its first action, so it and the game it was saved from go on tick for tick, and `world.hash()` says so.
- `{ time: false }` is for games that reached the same place in a different number of ticks. Nothing the package compares uses it, since two games whose times differ go on differently: a system that reads `Time` sees it.
- It leaves out the clock and nothing else. The buttons the world keeps, with the ticks each went down and up, are what the player did and are in both hashes, so a game whose player pressed a key during the pause, or at another tick, hashes differently.

## Read more

- [`Replay`](/reference/arcadekit/Replay), [`App`](/reference/arcadekit/App) and [`Action`](/reference/arcadekit/Action) in the API reference, and the world's [`hash`](/reference/arcadekit/ecs#world).
- [Determinism](../concepts/determinism.md), for what your game must avoid.
