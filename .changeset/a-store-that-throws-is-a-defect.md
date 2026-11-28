---
"arcadekit": minor
---

`Save.autosave` no longer catches what a store throws. A store fails with `Save.StoreFailed` when it can't keep a slot, and the slot's status and the log say so while the game goes on, as before. A store that throws in place of failing has a bug, and its defect now kills the game as any other does: the tick or the dispatch that asked dies with it, and so does `Driver.run`.

**Breaking**: a store of the game's own that throws, where it counted as `Save.StoreFailed` with `SlotStatus.Failed`, stops the game. Fail with `Save.StoreFailed` for what the store can't do, as `Browser.saves` does. `Browser.saves` and `Save.makeMemory()` change nothing.
