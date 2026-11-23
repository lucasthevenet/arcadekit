---
"arcadekit": minor
---

The code of the tick, a system of the tick, a state's hook, an action's handler, a plugin's `setup` and a tick system's `runIf` and `otherwise`, requires only the built-in services of the simulation (`World`, `Time`, `Commands`, `Events`, `Actions`, `Random`), and the queries, singletons, states, events and resources it yields. A service of the game's own, from a plugin's `layer` or given to `App.make`, doesn't compile there, since what it keeps is no part of the world and no save, rewind or refused action sees it. Frame and input systems require such services as before.

**Breaking**

- A tick system, handler or setup that requires a service of yours doesn't compile, and the error says where each thing goes:
  - the game's state goes in the world, as a component or a singleton;
  - a cache rebuilt from the world, such as a spatial index, goes in a `Field.transient` field of a singleton, which a system rebuilds when it finds it undefined;
  - configuration is a `Resource`;
  - a sound, a log line or a network call is made from `System.frame`, which hears the tick's events.
