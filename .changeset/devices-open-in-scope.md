---
"arcadekit": minor
---

A page's devices are opened in the scope of the program that makes the app, not where `Browser.layer` is provided. `Input.Source` holds `open`, an effect that opens the devices in the current scope and closes them with that scope, and `App.make` opens it. `Browser.layer` provided to `App.make` alone stopped listening once the app was made, and the first read threw; now the devices are heard for as long as the program that made the app, wherever the layer is provided. Each app opens its own, so two apps made under one `Browser.layer` each hear every press, where before they shared one set of listeners and the first to read took the presses from the other. `Input.open` opens the devices for a program that samples them itself, and `Input.layer(source)` provides devices made by hand, such as `Input.makeManualSource()`.

The page's sound in `Browser.layer` is still made when the layer is built, so provide the layer to the whole program, as `Browser.runMain` does, for its sound to last.

What breaks:

- `Effect.provideService(Input.Source, source)` is `Effect.provide(Input.layer(source))`.
- `yield* Input.Source` gives `{ open }`, not the devices: `yield* Input.open` gives them, in the current scope.
- `Input.SourceShape` is the open devices, `{ sample }`, and `Input.Source` is no longer a source of that shape.
- `Browser.layer` opens no listeners when it is built: `Layer.build(Browser.layer())` no longer listens to the page.
