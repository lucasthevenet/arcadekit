---
"arcadekit": minor
---

An app's world holds the actions queued for the next tick, with who issued them, and the events the simulation has yet to read, as singletons of its own, `arcadekit/Queued` and `arcadekit/events/<the event's name>`. `world.snapshot()`, `world.load()`, `world.restore()` and `world.hash()` cover them, each value in its JSON form, so two peers or a replay whose queued actions or waiting events differ disagree at that checkpoint, not later when it reaches the world, and a restored world is the whole game again. After `world.restore()`, every system reads the waiting events as if it had read none of them, as in a loaded game. Where each reader is, how far a system has read and what change queries haven't visited, stays out of the world, so a plugin that only watches doesn't change the hash. `app.capture()` holds the queued actions and the events by reference, as before, and encodes none of them.

`verifyFrames` checks the hash without the queued actions, since issuing them is what the input and frame stages are for.

**Breaking**

- `world.hash()` of an app differs from what an earlier release computed whenever an action is queued or an event waits, so a recording made with an earlier release no longer replays. A world made with `new EcsWorld()` hashes as before.
- Snapshots are written in format 4, which puts the singletons before the tables and has a field kind for lists. Formats 1 to 3 are still read; an earlier release can't read format 4.
- `Save.Save` and `Save.Contents` have no `queued`, and their `events` hold only `{ name, read }`: the actions and the events are in the world, under `world.singletons` of the contents, the `actions` field of `arcadekit/Queued` for the actions and the `waiting` field of `arcadekit/events/<the event's name>` for each event's. A migration that changed `queued` or the payloads of `events` changes those instead.
- `Save.LoadRefused` no longer has the problems `"unknown event"` and `"event changed"`: a waiting event this program doesn't define is a snapshot's `"unknown component"`, and one its schema no longer takes is `"component changed"`.
