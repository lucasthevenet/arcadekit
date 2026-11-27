---
"arcadekit": minor
---

A game's UI can tell whether an autosave kept the game. `Save.slot(name)` names a slot, and in a frame or input system `yield*` of it returns its status: `Off` when nothing autosaves the app, `Unasked`, `Saved`, or `Failed` with `Save.Refused` or `Save.StoreFailed`. `Save.match` gives a case for each:

```ts
const Auto = Save.slot("auto");
const Saved = View.define("game/Saved", { label: "" });

const ShowSaved = View.publish(Saved, function* () {
  return {
    label: Save.match(yield* Auto, {
      Off: () => "",
      Unasked: () => "",
      Saved: () => "Saved",
      Failed: ({ error }) => `Not saved: ${error.message}`,
    }),
  };
});
```

The status is outside the world, as a setting is: the hash, the log and a save don't hold it, and the code of the tick can't read it. A failed autosave is still logged as an error, and a store that throws in place of failing now counts as `Save.StoreFailed`.

Nothing breaks.
