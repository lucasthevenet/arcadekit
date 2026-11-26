---
"arcadekit": minor
---

An accessor that `each` or `single()` handed out throws, naming the component and field, when it is read or written after the world's entities changed: a spawn, a despawn, an add or a remove, as commands make when they are applied, and a restore or a rewind. Before, it read and wrote the row it was handed out for, which by then could be another entity's, or a column the table no longer used, and nothing said so. Its getters and setters check nothing: the change points a kept accessor at a column that refuses, so a loop costs what it did.

**Breaking**

- An accessor kept past a change of the world's entities throws where it read and wrote. Keep the entity's id and read it again with `world.get`, or call `single()` again, as a system does every tick; or queue the change on `Commands`, so it is made once the accessor is no longer used.
