---
"arcadekit": minor
---

A state's singleton keeps whether its first state was entered as a `Field.bool`, where it kept a `Field.u8` of 0 and 1. `app.inspect()` shows it as `entered: true` or `false`. A save written before loads as it did, with no migration, and a save's bytes and the hash are what they were.

**Breaking**

- `State.initial.entered` is a boolean, where it was a number. A game that read it compares with `true` instead of 1.
