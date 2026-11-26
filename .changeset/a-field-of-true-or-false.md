---
"arcadekit": minor
---

`Field.bool` holds `true` or `false`, where a game wrote `Field.u8` and compared with 1. It reads and writes as a boolean in `each`, `world.get`, `set`, `of`, a singleton and `app.inspect()`, and is 1 or 0 in the `Uint8Array` that `eachChunk` hands out. A snapshot and the hash take it for a `Field.u8`, so a save written while the field was a `Field.u8` loads with no migration. `FieldDef` has a `bool` property, true for `Field.bool` alone, and `ComponentDef` a `bools` property, the names of its `Field.bool` fields.

Nothing breaks.
