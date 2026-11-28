---
"arcadekit": minor
---

An action and a plugin offer a game only the members it reads. `Action.Action` has no `_P`: its own `in out P` keeps an action from passing for one of another payload. `Plugin.Plugin` has no `_types`: it carries its types under a key that no game can name, and an editor doesn't offer it.

**Breaking**

- A type that read `_P` of an action, or `_types` of a plugin, reads the same types another way. For a plugin, it uses `Plugin.TickErrorOf`, `Plugin.HandlerOf`, `Plugin.ProvidedOf`, `Plugin.ErrorOf`, `Plugin.LayerNeedsOf` or `Plugin.NeedsOf`. For an action, it uses `T extends Action.Action<infer N, infer P, infer E>`.
