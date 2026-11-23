---
"arcadekit": minor
---

A plugin's `layer` reads the game and cannot change it. A layer is built again when a save is loaded, so what it spawned was in the save and spawned a second time. A layer that requires `Commands`, `World.writes`, a query that writes or `Sim` doesn't compile now, and the error says to spawn in the plugin's `setup`, which a load does not run.

**Breaking**

- A layer that spawned or wrote a component moves that work to the plugin's `setup`. What the layer returned of what it spawned, such as a `Spawned` id, is found from the world instead, with a query.
