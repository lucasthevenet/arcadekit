---
"arcadekit": minor
---

A field and a component offer a game only the members it reads. `FieldDef` has no `_T`, which `initial` and `codec` already carry, and no `_C`: it carries its column's type under a key that no game can name, and an editor doesn't offer it. `ComponentDef` has no `_requires`, and carries the names it requires the same way. `ValueOf`, `RequiredOf` and the columns that `eachChunk` hands out read the same types as before.

**Breaking**

- A type that read `_T`, `_C` or `_requires` reads the same types another way: `T extends FieldDef<infer V, infer C>` for a field, and `RequiredOf` for what a component requires.
