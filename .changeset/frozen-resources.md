---
"arcadekit": minor
---

A resource's value is read-only: `Resource.make` types it as `Resource.Frozen<A>`, read-only all the way down, and freezes a plain object or array, as `Resource.layer` does its value. A system that changed a resource's default changed it for every app in the process, such as the next test in the same file.

**Breaking**

- `Resource.make` returns `Context.Reference<Resource.Frozen<A>>`, so a write to its value is a compile error, and one that gets past the compiler throws. Provide another value with `Resource.layer` instead of changing it.
