---
"arcadekit": minor
---

The app hands its UI the view bridge. `View.layer(game, mount)` gives an app a UI: when the app is made, `View.plugin` makes the bridge and calls `mount` with it, and a function `mount` returns is called when the app closes. A UI can no longer hold a bridge that no app reads, which took every `send` and queued it forever with no error. A game without `View.plugin`, itself or through one of its plugins, does not compile there.

**Breaking**

- `View.makeBridge(game)` is gone, and `View.layer(bridge)` is `View.layer(game, mount)`. A page that wrote `const ui = View.makeBridge(Arcade); mount(root, ui)` and provided `View.layer(ui)` now provides `View.layer(Arcade, (ui) => mount(root, ui))`.
- A UI is mounted when the app is made, not before. It sees every view at its initial value until the first frame publishes it.
- The `View.Bridge` reference, the bridge that stood for no UI, is gone. An app with no `View.layer` has no UI, as before.
- `View.Bridge` no longer has `_publish` and `_take`. A wrapper of a bridge passes on `get`, `subscribe` and `send`.
