---
"arcadekit": minor
---

`State.scoped(Phase, "playing")` is the tag of an entity that lives only while the game is in `"playing"`. When the game leaves `"playing"`, the entities with the tag are despawned, after the exit hooks and before the enter hooks, unless they also have the tag of the state the game enters. A level tagged with `"playing"` and `"paused"` stays through a pause. The tags are components named `"<state>.Scoped.<value>"`, saved, hashed and rewound like any other. A save that holds the tag of a value the state no longer has fails to load with `Save.LoadRefused`, `"unknown component"`.

Nothing breaks. A game that does not use `State.scoped` keeps the same hash and the same saves.
