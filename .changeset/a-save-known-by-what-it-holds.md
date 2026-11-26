---
"arcadekit": minor
---

`Replay.record(app, save)` knows a save by what it holds, so a copy read back from its bytes, as `Save.read` gives one from a slot, starts a recording.

```ts
Effect.gen(function* () {
  const saved = yield* Save.read("auto");
  return yield* Replay.record(app, Option.getOrThrow(saved));
});
```

**Breaking**

- `Replay.record(app, save)` dies for a save its app's log no longer reaches: one taken before the app loaded a save in place, or one the game went back to before, with `Timeline.rewind` or `Timeline.undo`, and came to again past a move or a tick of another length, the same moves as before included. It recorded such a save when the ticks of the log happened to agree with it, and the recording replayed right only when the moves were the same. Record since a save taken after the load or the rewind, or record all of it.
- In a session that runs ahead, a save of a tick that wasn't final dies once a late move rolls the game back past it, even when the game comes to the same save again, which it recorded before. Record since a save taken at a tick no later than `session.confirmed`, or record all of it.
