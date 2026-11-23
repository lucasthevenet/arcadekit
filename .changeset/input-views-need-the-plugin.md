---
"arcadekit": minor
---

`Input.Keyboard`, `Input.Pointer` and the new `Input.Gamepads` are services that `Input.plugin` provides. A game that reads the keyboard, the pointer or a gamepad and leaves out `Input.plugin` no longer compiles. Before, it ran, and every button read as up and every axis as 0.

**Breaking**

- A game that reads `Input.Keyboard`, `Input.Pointer` or `Input.Gamepad(index)` lists `Input.plugin` among its plugins, or `App.make` requires the missing service.
- `Input.Keyboard` and `Input.Pointer` are `Context.Service` tags, no longer plain Effects. `yield* Input.Keyboard` reads the same. `Input.Gamepad(index)` returns an `Effect` that requires `Input.Gamepads`.
- `app.read` no longer accepts them, since it provides only `World` and `Time`.
