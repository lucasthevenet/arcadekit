---
"arcadekit": patch
---

`World.rollback()` with no transaction in progress throws before it changes anything. It used to put `world.random` back to where it was at the last `begin` before it threw, so the world's hash changed on a call that was refused. Nothing breaks.
