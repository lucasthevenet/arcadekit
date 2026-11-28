---
"arcadekit": patch
---

A save that holds a number other than 0 or 1 in a field the game now defines as a `Field.bool` is refused with `"component changed"`, naming the field and the number, where it loaded as `true`. Such a save was written while the field was a `Field.u8` count, and a migration's `mapField` says what the count becomes. A save of a `Field.u8` of 0 and 1 still loads with no migration, and a save's bytes and the hash are what they were. A snapshot refuses a `Field.bool` whose column holds another number, which a loop can write there through `eachChunk`, with `"cannot be saved"`, so that no save a game makes is refused when it loads.

Nothing breaks: `Field.bool` is new in this release.
