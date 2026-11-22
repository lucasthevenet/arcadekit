---
"arcadekit": patch
---

A snapshot's format is read in one place and written in one. `world.snapshot()` and `writeSnapshot` wrote it separately, and `world.load()` and `readSnapshot` read it separately, so a change to the format was made four times. A snapshot's bytes are what they were, and every format a world read, it still reads.

Nothing breaks. Two messages changed: when `writeSnapshot` is given a field or a store that holds what is not plain data, it now says what the value is, as `world.snapshot()` does.
