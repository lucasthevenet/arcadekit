---
"arcadekit": minor
---

The world holds the game's time, as the singleton `arcadekit/Time`, so `world.snapshot()`, `world.restore()` and `world.hash()` cover it. A world restored from a snapshot has its time back with nothing else to do, and two peers whose `delta` differs disagree at the next checkpoint. A save no longer carries the time beside the world.

**Breaking**

- `Save.Save` and `Save.Contents` have no `tick`, `elapsed` or `delta`. A game reads the time of a loaded save from `app.time`, and a migration that changes it edits the singleton `arcadekit/Time` in `contents.world`.
- Saves are in format 2. A save written before this release is refused by `Save.decode`.
- `world.hash()` changes from tick to tick even when nothing else does, and differs from what an earlier release computed for the same game, so a recording made with an earlier release no longer replays.
- `app.inspect().singletons` and a migration's `contents.world` list `arcadekit/Time`.
