---
title: "Capturing and rewinding"
description: "Timeline captures a moment of an app's game in memory and puts the same app back to it, for an undo, a search ahead, a rewind mechanic or a tool."
---

A **moment** is an app's game captured in memory. `Timeline` puts the same app back to a moment, for an undo, a search ahead, a rewind mechanic or a tool. A [rollback session](sessions.md#run-ahead-of-the-network) rewinds this way each time a prediction was wrong.

## Capture a moment and rewind to it

```ts
import { App, Plugin, Timeline } from "arcadekit";
import { Effect } from "effect";

const Game = Plugin.make("game/Game", {});

const program = Effect.gen(function* () {
  const app = yield* Effect.acquireRelease(
    App.make(App.define({ plugins: [Game] })),
    (made) => made.close
  );
  const moment = yield* Timeline.capture(app); // fails with Save.Refused
  yield* app.tick(1 / 60);
  yield* Timeline.rewind(app, moment); // the same app, as it was
}).pipe(Effect.scoped);
```

- A moment holds what a [save](saving-and-loading.md) does: the world, the game time, the actions queued for the next tick, the events waiting to be read with every reader's place in them, what change queries haven't visited, and the log's length. `rewind` restores all of it in place, and takes the log back to that length. The app, its world and its services are the same objects as before.
- A moment lives in memory and belongs to one app in one run of the program. It holds pending actions and events as they are, without encoding them. A game whose pending payload its schema doesn't take can't be saved, but it can be captured.
- Capture and rewind only between ticks. Either call throws during a tick, a run of the frame or input stage, or a handler.
- A rewind leaves state outside the world as it is, such as a variable of a module. [Prepare a game for online play](sessions.md#prepare-a-game-for-online-play) says what to keep in the world.
- A `Field.transient` field keeps its value through a rewind in a table that nothing changed since the moment: no loop or `world.set` wrote its component there, and no entity joined or left the table. Elsewhere it is `undefined`, and the system that builds it builds it again. A cache in a transient field survives a rewind past ticks that didn't touch what it caches.
- Capture and rewind cost what changed since the last capture, not the size of the world. A table counts as changed for a component when a loop of a query that [writes](queries.md#name-what-a-query-writes) it visits the table, even if the loop writes nothing, or when `world.set` writes it, or when an entity joins or leaves the table. See [performance](performance.md#hashing-snapshots-and-rewinds).

## Keep an undo stack

```ts
import {
  Action,
  App,
  Driver,
  Field,
  Input,
  Plugin,
  Singleton,
  System,
  Timeline,
} from "arcadekit";
import { Browser } from "arcadekit/browser";
import { Schema } from "effect";

const Cell = Singleton.define("game/Cell", { x: Field.i32 }, { x: 0 });
const Step = Action.define("game/Step", Schema.Struct({ dx: Schema.Int }));
const step = Action.handler(Step, function* ({ dx }) {
  (yield* Singleton.Write(Cell)).x += dx;
});
const Keys = System.input("game/Keys", function* () {
  const { pressed } = yield* Input.Devices;
  const { enqueue } = yield* Action.Actions;
  if (pressed.includes("ArrowRight")) {
    enqueue(Step, { dx: 1 });
  }
  if (pressed.includes("KeyZ")) {
    enqueue(Timeline.Undo);
  }
  if (pressed.includes("KeyY")) {
    enqueue(Timeline.Redo);
  }
});
const Puzzle = App.define({
  plugins: [
    Plugin.make("game/Puzzle", {
      plugins: [Timeline.plugin],
      systems: [Keys],
      handlers: [step],
    }),
  ],
});

Browser.runMain(
  Driver.run(Puzzle, {
    hz: 60,
    ticks: "whenNeeded",
    ready: (app) => Timeline.keep(app, { last: 50 }),
  }),
  { target: document.querySelector("canvas")! }
);
```

`Timeline.keep(app)` keeps a game's turns: the game as it was before each turn, for as long as the scope it runs in lasts. A **turn** is what a tick or a dispatched action did with what came from outside: a move of the player's, from a key, a UI or `app.enqueue`. A tick with nothing from outside isn't one.

- `Timeline.Undo` goes back a turn, and `Timeline.Redo` forward again one it went back. They are actions, so a key bound to them in the input stage, a UI that sends them with `ui.send(Timeline.Undo)`, and the rules ask for them alike. The game lists `Timeline.plugin`, which handles them, and the app goes back or forward once the tick that applies one has run.
- Code outside the game goes back and forward with `Timeline.undo(app)` and `Timeline.redo(app)`, between ticks. Each succeeds with whether there was a turn to go to.
- Going back is a rewind, so the log goes with it. A recording holds the turns that are left, and replays to the game as it is.
- A move, a load or a rewind gives up every turn ahead: there is nothing to redo once the player has played on. A tick with no move gives up none, so a game that ticks by itself keeps its redo until the next move, as a game that ticks only when needed does.
- A redo goes to the game as it was at the undo, and gives up the ticks run since, as an undo gives up those run since the turn. What moves at rest, such as a running timer, is as it was at the undo.
- `app.load` gives up every turn kept, which are of the game the load replaced.
- It keeps the `last` turns, 100 by default. It captures the game when a move arrives, before the tick or the dispatch that applies it, which costs what changed since the last capture. A tick with no move captures nothing, so a game at rest pays for no capture.
- An app that a session steps can't be kept: it has no `tick`, and a turn gone back would be this machine's alone.

## Control what the frame and input stages hear after a rewind

- After `Timeline.rewind`, the game plays on from the moment. The frame and input stages, and code outside the game that reads an event, hear every event it emits from then on, including one they heard before the rewind, and their change queries visit everything again. They hear nothing of the future that was given up before they had read it.
- To run the same ticks again, as a rollback session does, pass `{ again: true }` to `Timeline.rewind`. Each of them then hears each event once. An event that a tick emits again, with the same payload, isn't heard twice. The two stages' change queries visit only what can differ from what they saw: what they had yet to visit, and the entities that the ticks given up or the ticks run again changed, spawned or despawned. A frame system that reads `Input.Keyboard`, `Input.Pointer` or `Input.Gamepads` isn't shown again a press it was shown, and is shown one that only the ticks run again have.
- For a rewind that comes before the two stages run again, capture with `Timeline.capture(app, { stages: true })`. The moment also keeps the stages' place in what changed, and their change queries go on from where they were.

## Tell a moment from a save, a recording and a snapshot

A game is kept in one of five ways, each with a name of its own:

| It is | Holds | Made by | For |
| --- | --- | --- | --- |
| A **moment**, `Timeline.Moment` | The game, in memory | `Timeline.capture(app)` | Going back in the same app: an undo, a rollback |
| A **save**, `Save.Save` | The game, as bytes it encodes to | `Save.make(app)` | Going on later, in this app with `Save.load` or in another with `App.make` |
| A **recording**, `Replay.Recording` | How the game began, and its log | `Replay.record(app)` | Playing the game again: `Replay.verify`, `Replay.play` |
| A **snapshot** | A world, as bytes | `world.snapshot()` | What a save holds of the world, and the storage core's own copy of one |
| A **hash check**, `Action.HashCheck` | The world's hash at a tick | `hashEvery`, `Replay.hashCheck(app)` | Comparing two runs of a game: a replay with its recording, peers with each other |

## Read more

- [Saving and loading](saving-and-loading.md), for a game kept beyond one run of the program.
- [`Timeline`](/reference/arcadekit/Timeline) in the API reference.
