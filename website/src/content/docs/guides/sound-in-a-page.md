---
title: "Playing sound in a page"
description: "In a page, cues and music play through Web Audio, from files the page names, clips a level's bundle loads, and streams for long music."
---

In a page, cues and music play through **Web Audio**. A sound comes from one of three places: a file that the page names for its lifetime, a clip that a level's bundle loads, or a stream for long music. [Sound](sound.md) covers cues and music themselves.

## Name the page's own sounds

`Browser.runMain` and `Browser.layer` provide the Web Audio output. Their `sounds` option maps the names that cues and tracks play by to the files that the page keeps for its lifetime. Their `volume` option sets the master volume. `Browser.layerSound(files)` provides the same sound layer on its own.

- The page's sound opens with the first app that has `Sound.plugin`, wherever the layer is provided, and is heard until that app is closed. The apps made under one `Browser.layer` share one audio context, because a browser allows a page only a few. They fetch each file once.
- `Assets.Loader` fetches the files when the page's sound opens, and each file is decoded on arrival.
- A browser lets a page make no sound until the user interacts with it. The page creates the audio context on the first key or pointer press, and cues requested from the next frame on play. A cue requested before that, or before its file has loaded, is dropped, because a late sound is worse than none. The first cue dropped before the first interaction is logged once by name, through Effect's logger, so a game that opens with a sound learns why it isn't heard.
- Cues play only while the audio is running. Resuming takes a moment when the page becomes visible again or a laptop lid opens. While the audio is suspended or resuming, cues are dropped, because otherwise they would queue up and all play at once.
- Music is never late, because it describes what should be playing. A track requested before the first interaction, or before its file has loaded, starts as soon as it can.
- A cue or track with no file, or whose file couldn't be fetched or decoded, is logged once and plays nothing.
- While the page is hidden, its audio is suspended, music included, as the frame loop is. The audio resumes when the page is visible again.
- A page without sounds of its own still has audio, for its levels' clips. `sounds: false` turns audio off. The page creates no audio context, and `audible` on `Sound.Player` is false.
- When the last app that plays through the page's sound is closed, or the page closes, the audio context closes and pending requests are cancelled. An app made after that opens the page's sound again, and the page waits for another touch.
- An app that plays after it was closed throws, with an error that says so.

## Play a level's own sounds

Sounds that a page receives by name last for the page's lifetime. A level's own sounds are assets of its bundle, made with `Browser.sound(url)`. They load when the game enters the level and are released when it leaves. See [assets](assets.md).

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

- A loaded sound is a `Sound.Clip`. It works anywhere a cue or track name does, such as `Sound.on(event, clip)`, `{ cue: clip, volume }`, `{ track: clip }`, and `player.play(clip)`.
- `Sound.cues(name, bundle, (assets) => mappings)` builds the mappings from the bundle's assets, once each time the bundle loads. While the bundle isn't loaded, the system plays nothing, and the events of that time aren't played later.
- A level's music is a body that reads the bundle and returns one of its clips once the bundle is `Ready`. When the game enters the level again, the bundle loads again and its music restarts.
- Both require `Assets.plugin`, and both systems' types say so.
- `Browser.sound(url)` is decoded in full on arrival. When its bundle releases it, a sound still playing plays to its end, or stops when its channel changes.

## Stream long music

A file given by URL, and a `Browser.sound`, are downloaded in full and kept decoded. A few minutes of decoded music take tens of megabytes. Stream a long piece instead, so the page downloads and decodes it as it plays. Name it in `sounds: { theme: Browser.stream("/theme.ogg") }`, or return `Browser.stream(url)` directly wherever a track is returned.

- A stream isn't an asset and belongs to no bundle. Nothing is downloaded until it plays, and there is nothing to release.
- It starts, fades, and stops like any track. It is for tracks only. Played as a cue, it is logged once and doesn't play.
- The page fetches it directly, not through `Assets.Loader`. A test that serves files from memory can't serve it, and plays its own clip, `Sound.clip(name)`, instead.
- A streamed track may have an audible gap where it loops. For a short piece that must loop without a gap, give its URL so the page decodes it in full.

## Read more

- [Assets](assets.md), for a level's bundle.
- [`Sound`](/reference/arcadekit/Sound) and [`Browser`](/reference/arcadekit/Browser) in the API reference.
