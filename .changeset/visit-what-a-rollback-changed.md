---
"arcadekit": minor
---

After `Timeline.rewind` with `{ again: true }`, as a rollback session does, the change queries of the frame and input stages visit only what can differ from what they saw: what they had yet to visit, and the entities that the ticks given up or the ticks run again changed, spawned or despawned. They used to visit every entity after each rewind, so a game drawn from `Query.changed` or `Query.added` redid the whole world on every rollback. A world keeps what its change logs held since each moment it captured, for as long as a moment is held.

**Breaking**

- A frame-stage or input-stage change query no longer visits every entity after a rewind with `again`. A system that relied on that to redraw everything visits a query without `Query.changed` or `Query.added` instead. A rewind without `again` still has them visit everything.
