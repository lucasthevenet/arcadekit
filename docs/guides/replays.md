# Replays

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

`app.actionLog` holds every action that came from outside, in the order it came, with its payload in JSON form and the tick it arrived at. Among them are checkpoints: the world's hash at a tick.

`App.replay(app, log, { delta, ticks })` plays the log into a fresh app made with the same plugins and seed, and started from the same state. It is told the tick length and how many ticks the game ran: the log doesn't say.

## Checkpoints

The app records a checkpoint before the first action or tick, then at the end of every tick whose number divides by `checkpointEvery`. `app.checkpoint()` records one more, for a moment the game wants checked, such as when it is saved.

A replay compares its own world at each checkpoint, and stops at the first that differs with `App.ReplayDiverged`. Its `reason` is an `App.HashMismatch` with the `expected` hash, the `actual` one, and `agreedAt`, the last tick that matched.

- `checkpointEvery` is 60 unless told. A checkpoint costs one hash of the world, 0.8 ms for 100,000 entities. A turn-based game, which ticks once a move, wants 1. With 0 the app records none.
- A replay made with another seed, or into a world that doesn't hold what the game's held, stops before its first tick.
- A dispatched action that the replay refuses, where the game accepted it, stops the replay too.

## What a replay doesn't do

- It runs no frame stage and no input stage: it reads no device and draws nothing. `App.replay` ticks with `{ input: false }`. A tool that replays by hand with `tick` says the same, or the machine's own keys join in.
- What the simulation issues itself, a bot's move, isn't in the log: the replay's own systems issue it again.
- A world changed from outside between ticks, a coin spawned into `app.world` by hand, is in neither the log nor the simulation. The replay stops at the next checkpoint.

## Read more

- [Replays that check themselves](../../packages/arcadekit/README.md#replays-that-check-themselves) in the reference.
- [Determinism](../concepts/determinism.md), for what a game must not do.
