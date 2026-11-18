---
title: "Sound"
description: "A sound is a named cue, played because something happened: the simulation emits an event, and what that event sounds like is said elsewhere. Music is what the game, as it is, should sound like."
---

A sound is a named cue, played because something happened: the simulation emits an event, and what that event sounds like is said elsewhere. Music is what the game, as it is, should sound like. Both are played from the frame stage. The simulation never plays.

## Cues

```ts
import { App, Event, Plugin, Sound } from "arcadekit";
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

Browser.runMain(App.run({ plugins: [Game] }, { hz: 60 }), {
  sounds: { coin: "/coin.wav", thud: "/thud.wav" },
});
```

- `Sound.cues` makes a system of the frame stage. Each frame it plays what the events since the last frame sound like. It hears every event once, however many ticks ran in between, as any frame system does.
- `Sound.on(event, cue)` is a line: a cue's name, a name with a `volume` and a `rate`, or a function of the payload that gives either, or nothing. `rate` is a cue's speed, and so its pitch. Several lines may be of one event, and each hears it.
- A cue asked for several times in one frame is played once, as the loudest asked: forty coins caught in one tick are one sound, not forty on top of each other. That holds across systems: two that play the same cue in a frame, a plugin's and the game's, make one sound of it.
- What a frame's systems ask to hear is played when they have all run, by a system of `"postFrame"` that `Sound.plugin` brings, in the order it was first asked for.
- What a refused action emitted is taken back with the rest, so it is never heard.

`Sound.Player` is the service that plays, which `Sound.plugin` provides. A frame system plays through it for a sound no event stands for: `(yield* Sound.Player).play("click", { volume: 0.5 })`. It is heard with the rest of its frame, and is one sound with whatever else asked for the same cue. Asked for in the input stage, it is heard with the frame that follows. In a tick it throws and says what to do instead, and an action's handler that plays dies of the same.

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

Each frame, the body says what should play: a track by a name the output knows, one with a `volume` and a `fade` of its own, or `undefined` for silence. A track plays over and over until the body says another.

Nothing happens while it says the same. When it says another track, the first fades out and the second fades in, over `fade` seconds; another volume is the same track, turned up or down as long. Half a second when nothing says.

- It is worked out from the game and kept nowhere in it, so a game loaded from a save, or an app that starts in the middle of a level, has its music from its first frame.
- Music is not for what happened once, which is a cue.
- `{ track: "fanfare", once: true }` plays to its end and no further. It is still what the channel is playing: it is not started again while the body says the same, another track fades it out if it has not ended, and it plays again from its start once the body has said something else in between.
- The body reads what a frame system can: singletons, states, queries, events, assets. Where sound goes nowhere it is not run at all.
- Under `System.runIf`, a music system that doesn't run says nothing should play, as if the body had said so: a level's music stops when the level is left, with the fade it was given, unless another system of its channel plays. Run again, the body says what plays, from the start of the track.
- When the app's scope closes, every channel that was playing is told silence at once.

### Channels

Every music system is of one score, on the channel `"music"`, unless given another. Of a menu's music and a level's, each a system that runs while the game is there, the one that has something to play is heard, and a track that both play goes on from the one to the other with nothing told. What a frame's systems say of a channel is made one thing when they have all run: silence gives way to a track, whichever was said first.

Two systems that say different tracks of one channel in one frame, or one track at two volumes, is a bug: the frame fails where the second is said, with an error that names the channel and both.

What plays beside the score has a channel of its own, any name: `Sound.music("game/Wind", body, { channel: "wind" })`. Two channels play together, and several systems can share that one too.

`(yield* Sound.Player).music(channel, track, { volume, fade })` is what `Sound.music` is made of, for a frame system of your own. It tells the output of a change and of nothing else, so it can be said every frame. In a tick it throws, as `play` does. The output is told at the end of the frame, as for a cue; said in the input stage, with the frame that follows.

## A level's own sounds

The sounds a page is given by name are there for as long as the page. A level's own are assets of its bundle, `Browser.sound(url)`, loaded when the game enters it and let go when it leaves. See [assets](assets.md).

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

// Its cues: lines made of what the bundle holds.
const ForestCues = Sound.cues("forest/Cues", Forest, ({ creak }) => [
  Sound.on(Stepped, ({ hard }) => ({ cue: creak, volume: hard ? 1 : 0.4 })),
]);

// Its music: a clip of the bundle, while the bundle is loaded.
// Beside the score, so on a channel of its own.
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

- A loaded sound is a `Sound.Clip`, and goes wherever a cue's or a track's name goes: `Sound.on(event, clip)`, `{ cue: clip, volume }`, `{ track: clip }`, `player.play(clip)`.
- `Sound.cues(name, bundle, (assets) => lines)` makes the lines of what the bundle holds, once each time it is loaded. While the app does not hold the bundle loaded it plays nothing, and what happened meanwhile is not played later.
- A level's music is a body that reads the bundle and gives one of its clips once it is `Ready`. Entered again, the level is loaded again, and its music starts again.
- Both need `Assets.plugin`, which the type of the cues' system says.
- `Browser.sound(url)` is decoded whole as it arrives. Let go with its bundle, what is still sounding of it plays to its end, or until its channel is told otherwise.

## In a page

The output is Web Audio, which `Browser.runMain` and `Browser.layer` provide. `sounds` gives the files of the sounds the page has for as long as it lasts, by the name a cue or a track is played by, and `volume` is how loud everything is played. `Browser.layerSound(files)` is the layer on its own.

- The files are fetched when the page starts, through `Assets.Loader`, and decoded as they arrive.
- A page may not make a sound before its user has touched it. The audio is made at the first key or pointer press, and a cue asked for in the frame after is played. A cue that was asked for before that, or before its file was there, is not played: a sound that is late is worse than none. The first cue that comes before the first touch is said once, by its name, through Effect's logger, so a game that opens with a sound is told why it isn't heard.
- A cue is played only by audio that is running. While the audio sleeps, or is still waking, which takes a moment when the page is seen again or a laptop's lid is opened, a cue is dropped: started then, it would wait, and every cue that waited would be heard at once.
- Music is never late: it is what should be playing. A track that was asked for before the first touch, or before its file was there, starts when it can.
- A cue or a track that has no file, or whose file could not be fetched or decoded, is logged once and plays nothing.
- While the page is hidden its audio sleeps, music and all, and wakes when the page is seen again: the frame loop rests then, and a game that stands still is not heard.
- A page with no files of its own still has sound, for the clips of its levels. `sounds: false` is a page with none: no audio is made, and the game is told that nothing is heard.
- When the page goes away the audio is closed, and a request still on its way is given up.

### A long piece of music

A file given by its URL, and `Browser.sound`, are fetched whole and held decoded, which for minutes of music is tens of megabytes. A long piece is streamed, fetched as it plays and decoded as it goes: `sounds: { theme: Browser.stream("/theme.ogg") }`, or `Browser.stream(url)` as it is wherever a track is said.

- A stream is no asset and is in no bundle: nothing is fetched until it is played, and there is nothing to let go.
- It is started, faded and stopped as any track, and is for a track only: played as a cue it is logged once and not played.
- The page fetches it, and not `Assets.Loader`: a test that provides its files in memory hears nothing of it, and plays a clip of its own, `Sound.clip(name)`, in its place.

## Heard or not, the same game

Sound follows real time and is no part of the game. A game that is heard has the same hash, log and save as one that is not, and a replay or a server, which run no frame stage, play nothing.

`Sound.Output` is where sound goes: a `Context.Reference` whose default is nowhere, and there the cues' system reads nothing. `Sound.layer(output)` provides one. A test provides `Sound.makeRecorder()`, which plays nothing and notes what it was asked: its cues in `played`, what each channel was told in `scored`, and what each is playing now in `playing`. See [testing](testing.md#sound).

`Sound.clip(name, data)` makes a clip by hand, for an output of your own or for a test, which needs nothing to play: a recorder notes a clip by its `name`, and the clip itself as `clip`.

## When a frame fails

What a frame that failed said of a channel stands until a frame ends. Systems that say something else of the channel in the next frame are refused as if two had spoken at once, unless the failure was that refusal itself. A game under a driver stops at a failed frame; a test that steps on after one has to know.

## With rollback

In a game of several peers played with [rollback](lockstep-and-rollback.md), a tick can be run again, and what the frame stage did for it is done again: the events of that tick are heard again, and a sound is played twice. A sound for something that is then taken back was played. The frame stage is not told which ticks are final: a game that must not play early asks its session, `session.confirmed`.

## Read more

- [`Sound`](/reference/arcadekit/Sound) in the API reference. What is not done yet: a cue that can be stopped, sound heard from where it is, music in time.
