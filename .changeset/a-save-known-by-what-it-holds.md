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

- `Replay.record(app, save)` dies for a save its app's log no longer reaches: one taken before the app loaded a save in place, or one the game went back to before, with `Timeline.rewind` or a session's rollback, and has not gone forward to again. It recorded such a save when the ticks of the log happened to agree with it, and the recording diverged when replayed. Record since a save taken after the load or the rewind, or record all of it.
