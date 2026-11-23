---
title: "Sound"
description: "Sound effects are named cues played in response to events, and music follows the game's current state. Both play from the frame stage, never from the simulation."
---

A **cue** is a named sound played because something happened: the simulation emits an event, and a separate system decides what that event sounds like. **Music** is what the game should sound like in its current state. Both play from the frame stage; the simulation never plays sound. [Playing sound in a page](sound-in-a-page.md) covers where a page's sounds come from.

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
- When the app's scope closes, every playing channel is silenced immediately.

### Channels

Every music system plays on the `"music"` channel unless given another. When a menu and a level each have a music system that runs while the game is there, the one with something to play is heard, and a track both play continues seamlessly from one to the other. A frame's systems are merged per channel once they have all run: a track wins over silence, and the first one returned wins among tracks.

Two systems returning different tracks for the same channel in one frame, or the same track at two volumes, is a bug: the frame fails where the second is returned, with an error naming the channel and both values.

Music that plays alongside the main score gets its own channel, with any name: `Sound.music("game/Wind", body, { channel: "wind" })`. Different channels play together, and several systems can share a channel.

`(yield* Sound.Player).music(channel, track, { volume, fade })` is the call `Sound.music` is built on, for a frame system of your own. It only sends the output changes, so you can call it every frame. The output receives it at the end of the frame, like a cue.

## Sound doesn't affect the game

Sound follows real time and isn't part of the game. A game with sound has the same hash, log and save as one without, and a replay or a server, which runs no frame stage, plays nothing.

`Sound.Output` is where sound goes: how to open a speaker, a `Context.Reference` whose default is nowhere, in which case the cue system reads nothing. `Sound.plugin` opens it in the scope the app is made in, and lets go of it when that scope closes. `Sound.layer(speaker)` provides a speaker made by hand, open already. A test provides `Sound.makeRecorder()`, which plays nothing and records what it was asked: its cues in `played`, what each channel was told in `scored`, and what each is playing now in `playing`. See [testing](testing.md#sound).

`Sound.clip(name, data)` creates a clip by hand, for a speaker of your own or for a test, which needs nothing to play: a recorder records a clip by its `name`, and the clip itself as `clip`.

## When a frame fails

What a failed frame set for a channel stays in place until a frame completes. Systems that set something different for that channel in the next frame are refused, as if two had set it at once, unless the failure was that conflict itself. A game under a driver stops at a failed frame; a test that keeps stepping after one must account for this.

## With rollback

In a multiplayer game played with [rollback](sessions.md), a tick can run again. A cue it plays again with the same payload plays once: the frame stage hears each event once however often a session runs its tick. A cue the tick now plays otherwise, or with another payload, plays then. A sound for something that is then rolled back has already played, and keeps playing. A game that must not play sounds early checks its session's `session.confirmed`.

## Read more

- [Playing sound in a page](sound-in-a-page.md).
- [`Sound`](/reference/arcadekit/Sound) in the API reference.
