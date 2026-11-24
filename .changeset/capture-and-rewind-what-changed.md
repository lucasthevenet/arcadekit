---
"arcadekit": minor
---

`Timeline.capture`, `Timeline.rewind` and `world.hash()` cost what changed since the last capture or hash, not the size of the world. A component's columns in a table count as changed when a loop of a query that names the component in `Query.writes` visits the table, whether or not it assigns a value, when `world.set` writes it, or when an entity joins or leaves the table. A moment copies only what changed and shares the rest with the moment before, and a rewind copies back only what changed, in place. Checkpoints, a replay's comparisons, `Session.syncTest` and `verifyFrames` still hash every column, so that a write through a cast past `Query.writes` shows up there.

**Breaking**

- `world.hash()` returns other numbers for the same world, since each column is now hashed on its own. A recording made by an earlier version fails its replay at its first checkpoint, with `Journal.ReplayDiverged`: record it again. Saves and snapshots are unchanged, and load as before.
- A `Field.transient` field keeps its value through `Timeline.rewind` in a table that nothing changed since the moment. It used to be `undefined` after every rewind, and still is where a loop or `world.set` wrote its component, or an entity joined or left its table. A system that builds a cache when it finds the field `undefined` works as before, and builds it less often.
