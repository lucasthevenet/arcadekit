---
title: "Capturing and rewinding"
description: "Timeline captures a moment of an app's game in memory and puts the same app back to it, for an undo, a search ahead, a rewind mechanic or a tool."
---

A **moment** is an app's game captured in memory, which `Timeline` puts the same app back to: for an undo, a search ahead, a rewind mechanic or a tool. A [rollback session](sessions.md#running-ahead-of-the-network) rewinds this way each time a prediction was wrong.

## Capturing a moment and rewinding to it

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

- A moment holds what a [save](saving-and-loading.md) does: the world, the game time, the actions queued for the next tick, the events waiting to be read with every reader's position, what change queries haven't visited, and the log's length. `rewind` restores all of it in place and truncates the log. The app, its world and its services are the same objects as before.
- It lives in memory and belongs to one app in one run of the program. It holds pending actions and events as they are and encodes none of them, so a game can be captured while a payload its schema doesn't take is pending, when it can't be saved.
- A game is captured and rewound between ticks. What a rewind doesn't restore is what [the requirements for online play](sessions.md#requirements-for-online-play) keep out of the simulation's way.

## The frame and input stages after a rewind

- After `Timeline.rewind`, the game plays on from the moment. The frame and input stages hear every event it emits from then on, including one they heard before the rewind, and their change queries visit everything again. They hear nothing of the future that was given up before they had read it.
- A session that rewinds to run the same ticks again passes `{ again: true }` to `Timeline.rewind`. That is the rewind after which the two stages hear each event once.
- `Timeline.capture(app, { stages: true })` also keeps the place of the frame and input stages in what changed, for a rewind that comes before they run again: their change queries then go on from where they were.

## Read more

- [Saving and loading](saving-and-loading.md), for a game kept beyond one run of the program.
- [`Timeline`](/reference/arcadekit/Timeline) in the API reference.
