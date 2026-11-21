---
"arcadekit": minor
---

Whether the input stage has run since the last tick is kept in the world, beside the actions it queued, instead of by the app. A rewind puts it back with them and a save holds it, so the next tick runs the stage when, and only when, the moment or the save was taken before it ran. Before, a rewind always ran the stage again, and a loaded game did too: a game captured or saved after the input stage applied that stage's actions twice. It is left out of `world.hash()`, as the input stage changes nothing a hash sees.

**Breaking**

- A save or a snapshot taken between the input stage and the tick holds a list `arcadekit/heard`, which an earlier release refuses as an `"unknown list"`. Saves from earlier releases load as before.
