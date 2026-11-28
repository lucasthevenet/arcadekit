---
"arcadekit": minor
---

A relation's `target`, the terms of a query and a component that a plugin keeps offer a game only the members it reads. `TargetField` has no `_target`, a query's terms have no `_reads`, `_maybe` or `_watched`, and `Plugin.KeptBy` has no `"~arcadekit/Plugin.KeptBy"`: each mark is kept under a key that no game can name, and an editor doesn't offer it. What each mark does is the same.

**Breaking**

- A type that read one of these members no longer compiles. The name of the plugin that keeps a component reads as `T extends Plugin.KeptBy<infer Id>`.
