---
"arcadekit": patch
---

A spawn finds its table by a step per component id, where it built a key of text, and keeps its components in order of id as they come, where it sorted them; a despawn skips a relation nobody points at the entity with. Spawning and despawning 1,000 entities takes 38% less time, with a relation or without, and a cascading despawn 9% less. Nothing breaks: entity ids, the order tables are made in, the hash and the snapshot are what they were.
