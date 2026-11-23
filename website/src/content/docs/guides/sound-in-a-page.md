---
title: "Playing sound in a page"
description: "In a page, cues and music play through Web Audio, from files the page names, clips a level's bundle loads, and streams for long music."
---

In a page, cues and music play through **Web Audio**. A sound comes from one of three places: a file the page names for its lifetime, a clip a level's bundle loads, or a stream for long music. [Sound](sound.md) covers cues and music themselves.

## The page's own sounds

The output is Web Audio, provided by `Browser.runMain` and `Browser.layer`. The `sounds` option maps the names cues and tracks play by to the files the page keeps for its lifetime, and `volume` sets the master volume. `Browser.layerSound(files)` provides the same layer on its own.

- The page's sound opens with the first app that has `Sound.plugin`, in the scope the app is made in, wherever the layer is provided. The apps made under one `Browser.layer` share it: one audio context, as a browser allows a page only a few, and each file fetched once.
- The files are fetched when the page's sound opens, through `Assets.Loader`, and decoded on arrival.
- A page may not make a sound until the user interacts with it. The audio context is created on the first key or pointer press, and cues requested from the next frame on play. A cue requested before that, or before its file has loaded, is dropped: a late sound is worse than none. The first cue dropped before the first interaction is logged once, by name, through Effect's logger, so a game that opens with a sound learns why it isn't heard.
- Cues only play while the audio is running. While the audio is suspended, or resuming, which takes a moment when the page becomes visible again or a laptop lid opens, cues are dropped: otherwise they would queue up and all play at once.
- Music is never late, since it describes what should be playing. A track requested before the first interaction, or before its file has loaded, starts as soon as it can.
- A cue or track with no file, or whose file couldn't be fetched or decoded, is logged once and plays nothing.
- While the page is hidden its audio is suspended, music included, and resumes when the page is visible again, matching the frame loop, which also pauses.
- A page without sounds of its own still has audio, for its levels' clips. `sounds: false` disables audio entirely: no audio context is created, and the game is told that nothing is heard.
- When the last app that plays through it goes, or the page closes, the audio context is closed and pending requests are cancelled. An app made after that opens the page's sound again, and the page waits for a touch again.

## A level's own sounds

Sounds a page receives by name are available for the page's lifetime. A level's own sounds are assets of its bundle, `Browser.sound(url)`, loaded when the game enters the level and released when it leaves. See [assets](assets.md).

```ts
import { Assets, Event, Sound } from "arcadekit";
import * as Browser from "arcadekit/Browser";
import { Schema } from "effect";

const Stepped = Event.define(
  "forest/Stepped",
  Schema.Struct({ hard: Schema.Boolean })
);

const Forest = Assets.bundle("game/Forest", {
  creak: Browser.sound("/creak.wav"),
  wind: Browser.sound("/wind.ogg"),
});

// Its cues, built from what the bundle holds.
const ForestCues = Sound.cues("forest/Cues", Forest, ({ creak }) => [
  Sound.on(Stepped, ({ hard }) => ({ cue: creak, volume: hard ? 1 : 0.4 })),
]);

// Its music: a clip from the bundle, while the bundle is loaded.
// It plays alongside the score, so on its own channel.
const Air = Sound.music(
  "forest/Air",
  function* () {
    const forest = yield* Forest;
    return forest._tag === "Ready"
      ? { track: forest.assets.wind, volume: 0.3 }
      : undefined;
  },
  { channel: "air" }
);
```

- A loaded sound is a `Sound.Clip`, and works anywhere a cue or track name does: `Sound.on(event, clip)`, `{ cue: clip, volume }`, `{ track: clip }`, `player.play(clip)`.
- `Sound.cues(name, bundle, (assets) => mappings)` builds the mappings from the bundle's assets, once each time it loads. While the bundle isn't loaded it plays nothing, and events in the meantime aren't played later.
- A level's music is a body that reads the bundle and returns one of its clips once it is `Ready`. When the level is entered again, it loads again and its music restarts.
- Both require `Assets.plugin`, as the cue system's type shows.
- `Browser.sound(url)` is fully decoded on arrival. When it is released with its bundle, whatever is still playing finishes, or stops when its channel changes.

## Streaming long music

A file given by URL, and `Browser.sound`, are downloaded in full and kept decoded, which for minutes of music is tens of megabytes. Stream long pieces instead, downloading and decoding them as they play: `sounds: { theme: Browser.stream("/theme.ogg") }`, or `Browser.stream(url)` directly wherever a track is returned.

- A stream isn't an asset and belongs to no bundle: nothing is downloaded until it plays, and there is nothing to release.
- It starts, fades and stops like any track, and is for tracks only: played as a cue, it is logged once and doesn't play.
- The page fetches it directly, not through `Assets.Loader`: a test that serves files from memory doesn't receive it, and plays its own clip, `Sound.clip(name)`, instead.
- A streamed track may have an audible gap where it loops. For a short piece that must loop seamlessly, give its URL so it is decoded in full.

## Read more

- [Assets](assets.md), for a level's bundle.
- [`Sound`](/reference/arcadekit/Sound) and [`Browser`](/reference/arcadekit/Browser) in the API reference.
