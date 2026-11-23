---
title: "Capturing and rewinding"
description: "Timeline captures a moment of an app's game in memory and puts the same app back to it, for an undo, a search ahead, a rewind mechanic or a tool."
---

A **moment** is an app's game captured in memory. `Timeline` puts the same app back to a moment, for an undo, a search ahead, a rewind mechanic or a tool. A [rollback session](sessions.md#run-ahead-of-the-network) rewinds this way each time a prediction was wrong.

## Capture a moment and rewind to it

```ts
import { App, Plugin, Timeline } from "arcadekit";
import { Effect, Exit } from "effect";

const Game = Plugin.make("game/Game", {});

const program = Effect.gen(function* () {
  const app = yield* App.make(App.define({ plugins: [Game] }));
  const moment = Timeline.capture(app); // Exit<Timeline.Moment, Save.SaveRefused>
  app.tick(1 / 60);
  if (Exit.isSuccess(moment)) {
    Timeline.rewind(app, moment.value); // the same app, as it was
  }
}).pipe(Effect.scoped);
```

- A moment holds what a [save](saving-and-loading.md) does: the world, the game time, the actions queued for the next tick, the events waiting to be read with every reader's place in them, what change queries haven't visited, and the log's length. `rewind` restores all of it in place, and takes the log back to that length. The app, its world and its services are the same objects as before.
- A moment lives in memory and belongs to one app in one run of the program. It holds pending actions and events as they are, without encoding them. A game whose pending payload its schema doesn't take can't be saved, but it can be captured.
- Capture and rewind only between ticks. Either call throws during a tick, a run of the frame or input stage, or a handler.
- A rewind leaves state outside the world as it is, such as a variable of a module, and a `Field.transient` field is `undefined` afterwards. [Prepare a game for online play](sessions.md#prepare-a-game-for-online-play) says what to keep in the world.

## Control what the frame and input stages hear after a rewind

- After `Timeline.rewind`, the game plays on from the moment. The frame and input stages hear every event it emits from then on, including one they heard before the rewind, and their change queries visit everything again. They hear nothing of the future that was given up before they had read it.
- To run the same ticks again, as a rollback session does, pass `{ again: true }` to `Timeline.rewind`. The two stages then hear each event once. An event that a tick emits again, with the same payload, isn't heard twice.
- For a rewind that comes before the two stages run again, capture with `Timeline.capture(app, { stages: true })`. The moment also keeps the stages' place in what changed, and their change queries go on from where they were.

## Read more

- [Saving and loading](saving-and-loading.md), for a game kept beyond one run of the program.
- [`Timeline`](/reference/arcadekit/Timeline) in the API reference.
