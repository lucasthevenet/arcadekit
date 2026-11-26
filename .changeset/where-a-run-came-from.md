---
"arcadekit": minor
---

A hook can tell where the game came from: `State.onTransition(Phase, { from: "menu", to: "playing" }, "StartRun", body)` runs on entering `"playing"` from the menu, and not on a resume from `"paused"`. `from` is one value or a list. A system names a run's scope once: `Commands.spawns(...).pipe(State.scoping(Phase, "playing", "paused"))` gives every entity those commands spawn the tags of both values, so no spawn leaves them off. The states guide shows a run that is started, paused, resumed and restarted.

Nothing breaks.
