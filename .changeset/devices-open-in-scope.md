---
"arcadekit": minor
---

A page's devices are listened to in the scope of the program that makes the app, not where `Browser.layer` is provided. `Input.Source` holds `listen`, an effect that starts listening to the devices in the current scope, stops when that scope closes, and gives an `Input.Listener`; `App.make` runs it. `Browser.layer` provided to `App.make` alone stopped listening once the app was made, and the first read threw; now the devices are heard for as long as the program that made the app, wherever the layer is provided. Each app listens for itself, so two apps made under one `Browser.layer` each hear every press, where before they shared one set of listeners and the first to read took the presses from the other. `Input.listen` listens to the devices for a program that samples them itself, and `Input.layer(listener)` provides devices made by hand, such as `Input.makeManualSource()`.

The page's sound in `Browser.layer` is still made when the layer is built, so provide the layer to the whole program, as `Browser.runMain` does, for its sound to last.

What breaks:

- `Effect.provideService(Input.Source, source)` is `Effect.provide(Input.layer(source))`.
- `yield* Input.Source` gives `{ listen }`, not the devices: `yield* Input.listen` gives them, in the current scope.
- `Input.SourceShape`, the devices being listened to, `{ sample }`, is `Input.Listener`. `Input.Source` is the interface of what the service holds.
- `Browser.layer` listens to nothing when it is built: `Layer.build(Browser.layer())` no longer listens to the page.
