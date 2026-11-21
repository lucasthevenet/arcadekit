---
"arcadekit": minor
---

An app's `world.hash()` covers the actions queued for the next tick, with who issued them, and the events the simulation has yet to read, each in its JSON form. Two peers or a replay whose queued actions or waiting events differ disagree at that checkpoint, not later when it reaches the world. Where each reader is, how far a system has read and what change queries haven't visited, stays out, so a plugin that only watches doesn't change the hash.

**Breaking**

- `world.hash()` of an app differs from what an earlier release computed whenever an action is queued or an event waits, so a recording made with an earlier release no longer replays. A world made with `new EcsWorld()` hashes as before.
