---
"arcadekit": minor
---

A world holds what an app keeps of a game beside its components in stores: the events waiting to be read with each system's place in them, the actions queued for the next tick, and what change queries have yet to visit. A store says what a snapshot holds of it, what the hash covers, what a rewind puts back and what a refused action takes back, so a save is the game's version, its world and the length of its log, and nothing of a game is kept next to its world.

`app.rewind()` goes back to play on from a moment, as an undo or a search ahead does: the frame and input stages hear every event the game emits from then on, where they missed one whose payload they had heard before the rewind. A session that goes back to run the same ticks again, as rollback does, still has them hear each event once, and an event is now matched only against one heard of the same tick, so one the ticks now emit on another tick is heard.

Whether the input stage has run since the last tick is saved and goes back with a rewind. A game that was saved, loaded or rewound between the input stage and its tick ran the stage a second time, and applied what it issued twice.

A refused action that called `Ticks.more()` has not asked for a tick: the app is as settled as it was.

`app.inspect()` has `stores`: the actions queued for the next tick and the events waiting to be read, as plain data.

**Breaking**

- `Save.Save` and `Save.Contents` have no `events` and no `changes`: both are in the world. A migration finds the waiting events under `Event.STORE`, the queued actions under `Action.INTAKE` and what change queries have yet to visit under `Save.VISITS`, in `world.stores` of the contents, where it found the first two in `world.lists`. A save's format is 3, and an earlier release's save is refused.
- Snapshot format 4 holds stores where it held lists: `SnapshotContents.stores`, each `{ name, data }`, replaces `SnapshotContents.lists`, and `SnapshotStore` replaces `SnapshotList`.
- `SnapshotProblem` has `"unknown store"` and `"store changed"` in place of `"unknown list"` and `"list changed"`. A waiting event this program doesn't define, or one its schema no longer takes, is `"store changed"`.
- A world loads what a store held only if it has that store: `new EcsWorld().load(bytes)` refuses the snapshot of an app that held queued actions or waiting events, with `"unknown store"`.
- `world.hash()` of an app differs from what an earlier release computed whenever an action is queued or an event waits, so a recording made with an earlier release no longer replays.
- `app.events.emit()` throws while the frame stage or the input stage runs, where it added an event no replay could repeat.
- A system of the frame or input stage that relied on `app.rewind()` not to hear an event twice reads what it needs from the world, or the game is stepped by a session.
- `Event.EventsMoment`, `Event.EventMark` and `Event.FRAME_READER` are gone, with the bus's `capture`, `rewind`, `save`, `restore`, `mark`, `rollback`, `commit`, `keepFor`, `beginTick`, `endTick`, `endFrame`, `endInput` and `waiting`, which were the app's to call.
- The app a session took over, `App.Diverted`, has `rewind`.
- `world.contents()` has `stores`.
