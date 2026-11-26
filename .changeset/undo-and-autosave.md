---
"arcadekit": minor
---

A game under `Driver.run` keeps its turns for an undo, and saves when its rules ask.

```ts
Driver.run(Puzzle, {
  hz: 60,
  ticks: "whenNeeded",
  ready: (app) => Effect.andThen(Timeline.keep(app), Save.autosave(app)),
});

// From the game's keys, its UI and its rules:
const Keys = System.input("game/Keys", function* () {
  (yield* Action.Actions).enqueue(Timeline.Undo, undefined);
});
ui.send(Timeline.Redo);
const Checkpoint = System.tick("game/Checkpoint", function* () {
  (yield* Save.Asked.emits).emit({ slot: "level" });
});
```

- `Timeline.keep(app)` keeps the game as it was before each turn, a tick or a dispatched action that applied a move from outside. `Timeline.undo(app)` and `Timeline.redo(app)` go back and forward a turn, and so do the actions `Timeline.Undo` and `Timeline.Redo`, which `Timeline.plugin` handles, once the tick that applies one has run.
- `Save.Asked` is the event a game's rules ask for a save with, and `Save.autosave(app)` takes the save once the tick or the dispatch that asked has run, and writes it to the slot in `Save.Store`. `Timer.every` makes it an interval kept in the world.
- A rewind puts the log as it was at the moment, to a moment of a future the game gave up as much as to one before: the entries, what became of each, and the ticks' deltas. A rewind forward to such a moment used to leave the log with holes in it.
- The capturing guide shows an undo stack, and the saving guide an autosave.

Nothing breaks.
