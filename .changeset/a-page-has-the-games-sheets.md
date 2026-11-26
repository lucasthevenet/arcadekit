---
"arcadekit": minor
---

A game that plays from a cue sheet its page wasn't given doesn't compile. A sheet is an Effect: a frame-stage system yields it for its sounds, and its type then requires `Sound.Plays<"game/Sfx">`, which only what says where the sound goes provides. A page provides it for each sheet in its `sounds`, of `Browser.runMain`, `Browser.layer` or `Audio.layerSound`, so a page missing one is a compile error that names the sheet. `Sound.layer(speaker)` and `Test.make` provide it for every sheet, as a recorder records any, and so does the new `Sound.layerNowhere`, by which sound goes nowhere, for a server or a replay. `Sound.cues(name, Sfx, (sounds) => lines)` builds a cue system from a sheet's sounds, as it does from a bundle's.

**Breaking**

- A sheet's sounds are no longer its properties. `Sound.on(Scored, Sfx.coin)` in `Sound.cues(name, ...lines)` is now `Sound.cues(name, Sfx, ({ coin }) => [Sound.on(Scored, coin)])`, and a music body or a frame system takes them with `yield*`: `const { theme } = yield* Tracks`. `Sound.Sheet` is a class, `Sound.Sheet<"game/Sfx", "coin" | "thud">`, where it was the record of its clips.
- A program that runs a game whose systems play from a sheet says where its sound goes. A page lists every such sheet in `sounds`, a stream's sheet too, and a server, a replay or a test that made its app with `App.make` and provided no `Sound.layer` provides `Sound.layerNowhere`.
- `Browser.layer` and `Audio.layerSound` give the type of their sheets, `Layer.Layer<Sound.Plays<"game/Sfx">>`, and `Sound.layer` gives `Layer.Layer<Sound.Plays<string>>`, where each gave `Layer.Layer<never>`.
