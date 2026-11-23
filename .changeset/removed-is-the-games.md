---
"arcadekit": minor
---

`Query.removed(X)` puts `WatchesRemoved<"X">` in what a system requires, as `Query.changed` and `Query.added` put theirs, so `app.read` doesn't take it: which removals a reader has read is the game's.

**Breaking**

- `app.read(Query.removed(X))` doesn't compile. Read removals in a system.
