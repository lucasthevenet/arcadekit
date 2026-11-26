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
  const moment = yield* Timeline.capture(app); // fails with Save.SaveRefused
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

## Control what the frame and input stages hear after a rewind

- After `Timeline.rewind`, the game plays on from the moment. The frame and input stages, and code outside the game that reads an event, hear every event it emits from then on, including one they heard before the rewind, and their change queries visit everything again. They hear nothing of the future that was given up before they had read it.
- To run the same ticks again, as a rollback session does, pass `{ again: true }` to `Timeline.rewind`. Each of them then hears each event once. An event that a tick emits again, with the same payload, isn't heard twice. The two stages' change queries visit only what can differ from what they saw: what they had yet to visit, and the entities that the ticks given up or the ticks run again changed, spawned or despawned.
- For a rewind that comes before the two stages run again, capture with `Timeline.capture(app, { stages: true })`. The moment also keeps the stages' place in what changed, and their change queries go on from where they were.

## Read more

- [Saving and loading](saving-and-loading.md), for a game kept beyond one run of the program.
- [`Timeline`](/reference/arcadekit/Timeline) in the API reference.
