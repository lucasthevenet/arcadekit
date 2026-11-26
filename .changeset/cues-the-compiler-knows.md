---
"arcadekit": minor
---

A game names its sounds in a cue sheet, and a menu sets how loud each kind is. `Sound.sheet(name, { coin: "/coin.wav", theme: Audio.stream("/theme.ogg") })` makes a clip for each sound, so `Sound.on(Scored, Sfx.coin)` plays one and a cue the sheet doesn't have doesn't compile. Every sound plays on a bus, and `Sound.Player`'s new `volume(bus, volume)` sets a bus's volume from a frame system: 0.5 at half, 0 silent. A bus is a value of the class `Sound.Bus`, declared once, so a bus that was never declared doesn't compile: `Sound.EffectsBus` is a cue's unless its options name another with `bus`, `Sound.MusicBus` a track's, and `Sound.bus(name)` declares one of a game's own. A game that needs only those two declares nothing: `player.volume(Sound.MusicBus, 0.5)`. A recorder records a sheet's sound by its name, as it recorded a named cue, at the volume it was played at, its bus's included.

**Breaking**

- The record of `sounds` by string is gone. `Browser.runMain(game, { sounds: { coin: "/coin.wav" } })` is now `Browser.runMain(game, { sounds: [Sfx] })` with `const Sfx = Sound.sheet("game/Sfx", { coin: "/coin.wav" })`, and `Audio.layerSound({ coin: "/coin.wav" })` is now `Audio.layerSound([Sfx])`.
- A cue or a track is a clip, never a name: `Sound.on(Scored, "coin")` is now `Sound.on(Scored, Sfx.coin)`, `player.play("click")` is `player.play(Sfx.click)`, and a music body returns `Tracks.theme` where it returned `"theme"`. `Sound.Playable` is `Sound.Clip`, and a `Sound.Speaker` of a game's own is given a clip.
- A sound of a sheet the page wasn't given is logged once with the sheet's name and plays nothing, where a name with no file was logged before.
- The page's example drops its `?stream` switch: its theme is a file of its sheet.
