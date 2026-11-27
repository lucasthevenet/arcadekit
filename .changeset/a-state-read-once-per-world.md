---
"arcadekit": patch
---

`yield*` on a state hands out the same reader each time in a world, where it made a new one on every yield. A condition of `State.is` costs about half what it did, and a system that it keeps from running now costs less than one that runs and does nothing. Ten systems that `System.runIf` skips tick in about half the time they did, and ten whose condition holds in about a quarter less.

Nothing breaks. The reader reads the world as it is when it is read, as before, and a reader from one world never reads another.
