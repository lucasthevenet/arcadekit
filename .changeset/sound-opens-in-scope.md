---
"arcadekit": minor
---

A page's sound opens in the scope of the program that makes the app, not where `Browser.layerSound` or `Browser.layer` is provided. `Sound.Output` holds `open`, an effect that opens a `Sound.Speaker` in the current scope and lets go of it when that scope closes, and `Sound.plugin` runs it in the scope the app is made in. Provided to `App.make` alone, the page's sound was closed once the app was made, and every cue after it played nothing, with no error; now it is heard for as long as the program that made the app, wherever the layer is provided. The page's audio is shared: the apps made under one provided layer play through one audio context and fetch each file once, and it is closed when the last of them lets go. `Sound.open` opens the output for a program that plays to it itself.

What breaks:

- `Sound.OutputShape`, what plays, `{ play, music }`, is `Sound.Speaker`. `Sound.Output` is the interface of what the service holds, `{ open }`.
- `Effect.provideService(Sound.Output, speaker)` is `Effect.provide(Sound.layer(speaker))`. `Sound.layer(speaker)` is called as before.
- `yield* Sound.Output` gives `{ open }`, not the speaker: `yield* Sound.open` gives it, in the current scope.
- `Browser.layerSound` opens nothing when it is built: `Layer.build(Browser.layerSound(files))` no longer fetches the files or listens for the first touch. The page's audio starts when the first app with `Sound.plugin` is made, so a game without it, under `Browser.layer`, no longer fetches the `sounds` files or listens for a touch.
- The page's audio closes when the last app that plays through it goes: an app made after that opens it again, and waits for a touch again.
