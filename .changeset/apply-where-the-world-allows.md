---
"arcadekit": minor
---

`CommandBuffer.apply` throws while a query is iterating, inside a transaction, and in a frozen world, before it makes any command, and keeps the whole queue for a later `apply`. It used to make a queued spawn there with no error, which a rollback did not undo, and to throw at the first despawn, add or remove after emptying the queue, which lost that command and every one after it.

**Breaking**: a call to `apply` in one of those places throws now, even when the queue holds only spawns or is empty. Call it after the loop, after `commit` or `rollback`, or after `thaw`.
