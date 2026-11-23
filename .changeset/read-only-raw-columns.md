---
"arcadekit": minor
---

An app made with `verifyFrames` refuses a write through a raw column that `eachChunk` hands out read-only, in every stage, the tick and an action's handler as much as the frame. Before, outside the frame and input stages, nothing saw it. `eachChunk` copies each such column, the fields of a term the query only reads and a relation's `target`, and compares it when the loop returns. A loop that changed one throws, naming the component and field, and the column is put back, so the world, its hash, its change queries and a refused action's rollback are as if the write was never made. It costs a copy and a comparison of each column handed out read-only, in an app made with `verifyFrames` and nowhere else.

**Breaking**

- With `verifyFrames`, a write through a raw column in the frame or input stage throws from `eachChunk`, and no longer dies with `Stage.FrameChangedWorld`. That error is left for a draw from `world.random`, and for a change a cast let through any other way.
- With `verifyFrames`, a tick system or an action's handler that writes a raw column it was handed read-only now throws, where the write went through.
