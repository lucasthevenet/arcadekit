---
"arcadekit": minor
---

Systems no longer declare what they read and write. A system runs in the order it is listed and as `System.after` and `System.before` say, the same on every run, so nothing in a game needs its access. `Query.reads` stays: it makes a query's terms read-only and keeps a raw loop from counting as a write to them.

**Breaking**

- `System.access`, `System.accessOf`, `System.conflicts` and their types `Access`, `Touch`, `Touched`, `Resolved`, `Conflict` and `Report` are removed. Drop `.pipe(System.access({ ... }))` from a system.
- `app.conflicts` and `app.undeclared` are removed. A test that asserted `app.conflicts` is empty drops the assertion.
- The world's guard is removed: `world.guard` and the `Guard` type of the storage core. Nothing refuses what a system touches any more.
