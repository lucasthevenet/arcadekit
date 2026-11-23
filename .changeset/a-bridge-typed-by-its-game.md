---
"arcadekit": minor
---

A view bridge is made from its game, and `bridge.send` takes only an action the game has a handler for: any other does not compile, where it threw when it was sent or in the game's first input stage. A UI names the actions it sends in its bridge's type, `View.Bridge<typeof Start | typeof Quit>`, and is handed only the bridge of a game that handles each of them.

**Breaking**

- `View.makeBridge()` is `View.makeBridge(game)`, given the game the bridge is provided to: `const ui = View.makeBridge(Arcade)` beside `App.make(Arcade)`.
- `View.Bridge` takes the actions it sends, `View.Bridge<typeof NewGame>`. A `View.Bridge` with none, as a UI was typed before, reads views and sends nothing: name the actions the UI sends.
- `send` no longer throws for an action the game has no handler for, since it does not compile. A bridge provided to the app of another game can still send one, which throws in that app's input stage.
