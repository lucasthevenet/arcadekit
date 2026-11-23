---
title: "Sound"
description: "Sound effects are named cues played in response to events, and music follows the game's current state. Both play from the frame stage, never from the simulation."
---

A **cue** is a named sound played because something happened: the simulation emits an event, and a separate system decides what that event sounds like. **Music** is what the game should sound like in its current state. Both play from the frame stage; the simulation never plays sound.

## Cues

```ts
import { App, Driver, Event, Plugin, Sound } from "arcadekit";
import * as Browser from "arcadekit/Browser";
import { Schema } from "effect";

const Scored = Event.define("game/Scored", Schema.Struct({}));
const Bounced = Event.define(
  "physics/Bounced",
  Schema.Struct({ speed: Schema.Finite })
);

const Cues = Sound.cues(
  "game/Cues",
  Sound.on(Scored, "coin"),
  Sound.on(Bounced, ({ speed }) =>
    speed < 2 ? undefined : { cue: "thud", volume: Math.min(1, speed / 10) }
  )
);

const Game = Plugin.make("game/Game", {
  plugins: [Sound.plugin],
  systems: [Cues],
});

Browser.runMain(
  Driver.run(App.make(App.define({ plugins: [Game] })), { hz: 60 }),
  {
    sounds: { coin: "/coin.wav", thud: "/thud.wav" },
  }
);
```

- `Sound.cues` creates a frame-stage system. Each frame, it plays the cues for the events since the last frame. Like every frame system, it sees each event once, however many ticks ran in between.
- `Sound.on(event, cue)` maps an event to a cue: a cue name, a name with a `volume` and a `rate`, or a function of the payload that returns either, or nothing. `rate` is the playback speed, and so also the pitch. Several mappings can share an event, and each one receives it.
- A cue requested several times in one frame plays once, at the loudest requested volume: forty coins caught in one tick make one sound, not forty stacked on top of each other. This holds across systems: if a plugin and your game both play the same cue in a frame, it plays once.
- Cues play after all of a frame's systems have run, in a `"postFrame"` system that `Sound.plugin` provides, in the order they were first requested.
- A cue plays once, to its end.
- Events emitted by a refused action are rolled back with everything else, so they are never heard.

`Sound.Player` is the service that plays sounds, provided by `Sound.plugin`. A frame system plays a sound that no event stands for through it: `(yield* Sound.Player).play("click", { volume: 0.5 })`. It plays with the rest of its frame, merged with any other request for the same cue. A system of the tick or the input stage, and an action handler, cannot require it.

## Music

```ts
import { Sound, State } from "arcadekit";

const Phase = State.define("game/Phase", ["menu", "playing", "paused"]);

const Score = Sound.music(
  "game/Score",
  function* () {
    const phase = yield* Phase;
    if (phase.is("menu")) {
      return undefined; // silence
    }
    return { track: "theme", volume: phase.is("paused") ? 0.1 : 0.4 };
  },
  { fade: 1 }
);
```

Each frame, the body returns what should play: a track by a name the output knows, a track with its own `volume` and `fade`, or `undefined` for silence. A track loops until the body returns another.

Nothing happens while the body returns the same thing. When it returns a different track, the first fades out while the second fades in, over `fade` seconds; a different volume for the same track fades to it over the same time. The fade defaults to half a second.

- Music is computed from the game and stored nowhere in it, so a game loaded from a save, or an app that starts in the middle of a level, has its music from the first frame.
- Music isn't for one-off sounds, which are cues.
- `{ track: "fanfare", once: true }` plays to its end and stops. It still counts as what the channel is playing: it doesn't restart while the body returns the same thing, a different track fades it out if it hasn't ended, and it plays again from the start once the body has returned something else in between.
- The body can read anything a frame system can: singletons, states, queries, events, assets. When sound has no output, the body doesn't run at all.
- Under `System.runIf`, a music system that doesn't run counts as returning silence: a level's music fades out when the level is left, with its configured fade, unless another system on its channel plays. When the system runs again, the body decides what plays, from the start of the track.
- When the app is closed, every playing channel is silenced immediately.

### Channels

Every music system plays on the `"music"` channel unless given another. When a menu and a level each have a music system that runs while the game is there, the one with something to play is heard, and a track both play continues seamlessly from one to the other. A frame's systems are merged per channel once they have all run: a track wins over silence, and the first one returned wins among tracks.

Two systems returning different tracks for the same channel in one frame, or the same track at two volumes, is a bug: the frame fails where the second is returned, with an error naming the channel and both values.

Music that plays alongside the main score gets its own channel, with any name: `Sound.music("game/Wind", body, { channel: "wind" })`. Different channels play together, and several systems can share a channel.

`(yield* Sound.Player).music(channel, track, { volume, fade })` is the call `Sound.music` is built on, for a frame system of your own. It only sends the output changes, so you can call it every frame. The output receives it at the end of the frame, like a cue.

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

## In a page

The output is Web Audio, provided by `Browser.runMain` and `Browser.layer`. The `sounds` option maps the names cues and tracks play by to the files the page keeps for its lifetime, and `volume` sets the master volume. `Browser.layerSound(files)` provides the same layer on its own.

- The page's sound opens with the first app that has `Sound.plugin`, wherever the layer is provided, and is heard until that app is closed. The apps made under one `Browser.layer` share it: one audio context, as a browser allows a page only a few, and each file fetched once. It closes with the last of them, and an app that plays after it was closed throws, and says so.
- The files are fetched when the page's sound opens, through `Assets.Loader`, and decoded on arrival.
- A page may not make a sound until the user interacts with it. The audio context is created on the first key or pointer press, and cues requested from the next frame on play. A cue requested before that, or before its file has loaded, is dropped: a late sound is worse than none. The first cue dropped before the first interaction is logged once, by name, through Effect's logger, so a game that opens with a sound learns why it isn't heard.
- Cues only play while the audio is running. While the audio is suspended, or resuming, which takes a moment when the page becomes visible again or a laptop lid opens, cues are dropped: otherwise they would queue up and all play at once.
- Music is never late, since it describes what should be playing. A track requested before the first interaction, or before its file has loaded, starts as soon as it can.
- A cue or track with no file, or whose file couldn't be fetched or decoded, is logged once and plays nothing.
- While the page is hidden its audio is suspended, music included, and resumes when the page is visible again, matching the frame loop, which also pauses.
- A page without sounds of its own still has audio, for its levels' clips. `sounds: false` disables audio entirely: no audio context is created, and the game is told that nothing is heard.
- When the last app that plays through it goes, or the page closes, the audio context is closed and pending requests are cancelled. An app made after that opens the page's sound again, and the page waits for a touch again.

### Streaming long music

A file given by URL, and `Browser.sound`, are downloaded in full and kept decoded, which for minutes of music is tens of megabytes. Stream long pieces instead, downloading and decoding them as they play: `sounds: { theme: Browser.stream("/theme.ogg") }`, or `Browser.stream(url)` directly wherever a track is returned.

- A stream isn't an asset and belongs to no bundle: nothing is downloaded until it plays, and there is nothing to release.
- It starts, fades and stops like any track, and is for tracks only: played as a cue, it is logged once and doesn't play.
- The page fetches it directly, not through `Assets.Loader`: a test that serves files from memory doesn't receive it, and plays its own clip, `Sound.clip(name)`, instead.
- A streamed track may have an audible gap where it loops. For a short piece that must loop seamlessly, give its URL so it is decoded in full.

## Sound doesn't affect the game

Sound follows real time and isn't part of the game. A game with sound has the same hash, log and save as one without, and a replay or a server, which runs no frame stage, plays nothing.

`Sound.Output` is where sound goes: how to open a speaker, a `Context.Reference` whose default is nowhere, in which case the cue system reads nothing. `Sound.plugin` opens it when the app is made, and lets go of it when the app is closed. `Sound.layer(speaker)` provides a speaker made by hand, open already. A test provides `Sound.makeRecorder()`, which plays nothing and records what it was asked: its cues in `played`, what each channel was told in `scored`, and what each is playing now in `playing`. See [testing](testing.md#sound).

`Sound.clip(name, data)` creates a clip by hand, for a speaker of your own or for a test, which needs nothing to play: a recorder records a clip by its `name`, and the clip itself as `clip`.

## When a frame fails

What a failed frame set for a channel stays in place until a frame completes. Systems that set something different for that channel in the next frame are refused, as if two had set it at once, unless the failure was that conflict itself. A game under a driver stops at a failed frame; a test that keeps stepping after one must account for this.

## With rollback

In a multiplayer game played with [rollback](sessions.md), a tick can run again. A cue it plays again with the same payload plays once: the frame stage hears each event once however often a session runs its tick. A cue the tick now plays otherwise, or with another payload, plays then. A sound for something that is then rolled back has already played, and keeps playing. A game that must not play sounds early checks its session's `session.confirmed`.

## Read more

- [`Sound`](/reference/arcadekit/Sound) in the API reference.
