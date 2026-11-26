---
"arcadekit": minor
---

A game's UI can tell that an autosave failed. `Save.failedAutosaves` holds each slot that `Save.autosave` couldn't keep the save the game asked for in, with `Save.Refused` or `Save.StoreFailed`, until a later ask keeps it. A frame or input system reads it, and publishes it as a view:

```ts
const Unsaved = View.define("game/Unsaved", { message: "" });

const ShowUnsaved = View.publish(Unsaved, function* () {
  const failed = (yield* Save.failedAutosaves).get("auto");
  return { message: failed?.message ?? "" };
});
```

It is outside the world, as a setting is: the hash, the log and a save don't hold it, and the code of the tick can't read it. A failed autosave is still logged as an error.

Nothing breaks.
