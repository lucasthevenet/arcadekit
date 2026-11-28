---
title: "Sound"
description: "Sound effects are cues of a cue sheet played in response to events, music follows the game's current state, and buses set how loud each kind is. All of it plays from the frame stage, never from the simulation."
---

A **cue** is a sound that plays because something happened. The simulation emits an event, and a separate system decides what that event sounds like. **Music** is what the game should sound like in its current state. A **cue sheet** names the game's sounds, and a **bus** sets how loud every sound on it is. All of it plays from the frame stage, and the simulation never plays sound. [Playing sound in a page](sound-in-a-page.md) covers where a page's sounds come from.

## Play a cue from an event

```ts
import { App, Driver, Event, Plugin, Sound } from "arcadekit";
import { Browser } from "arcadekit/browser";
import { Schema } from "effect";

const Scored = Event.define("game/Scored");
const Bounced = Event.define(
  "physics/Bounced",
  Schema.Struct({ speed: Schema.Finite })
);

// The game's sounds: a cue that isn't in the sheet doesn't compile.
const Sfx = Sound.sheet("game/Sfx", { coin: "/coin.wav", thud: "/thud.wav" });

const Cues = Sound.cues("game/Cues", Sfx, ({ coin, thud }) => [
  Sound.on(Scored, coin),
  Sound.on(Bounced, ({ speed }) =>
    speed < 2 ? undefined : { cue: thud, volume: Math.min(1, speed / 10) }
  ),
]);

const Game = Plugin.make("game/Game", {
  plugins: [Sound.plugin],
  systems: [Cues],
});

// The game plays from Sfx: without it in sounds, this doesn't compile.
Browser.runMain(Driver.run(App.define({ plugins: [Game] }), { hz: 60 }), {
  sounds: [Sfx],
});
```

- `Sound.sheet(name, files)` makes a clip for each sound, from the URL of its file or from a clip such as `Audio.stream(url)`. A frame system asks for the sheet's sounds with `yield* Sound.Clips(Sfx)`, as `Sound.cues(name, Sfx, ({ coin }) => mappings)` does, so `coni` doesn't compile. A level's own sounds are assets of its bundle instead, which [playing sound in a page](sound-in-a-page.md#play-a-levels-own-sounds) covers.
- `Sound.cues` makes a frame-stage system. Each frame, it plays the cues for the events since the last frame. Like every frame system, it sees each event once, however many ticks ran in between.
- `Sound.on(event, cue)` maps an event to a cue. The cue is a clip, a clip with a `volume`, a `rate` and a `bus`, or a function of the payload that returns either one or nothing. `rate` is the playback speed, so it also sets the pitch. A volume below 0 counts as 0. Several mappings can share an event, and each one receives it.
- A cue requested several times in one frame plays once, at the loudest requested volume. Forty coins caught in one tick make one sound, not forty. The same holds across systems. If a plugin and your game both play the same cue in a frame, it plays once.
- Cues play after all of a frame's systems have run, in the order they were first requested. A `"postFrame"` system that `Sound.plugin` provides plays them. A frame that fails plays nothing it requested, cues or music, and the next frame starts from nothing.
- A cue plays once, to its end.
- Events emitted by a refused action are rolled back with everything else, so they are never heard.

`Sound.plugin` provides `Sound.Player`, the service that plays sounds. A frame system plays a sound that no event stands for through it, as in `player.play((yield* Sound.Clips(Sfx)).click, { volume: 0.5 })`. The sound plays with the rest of its frame, merged with any other request for the same cue. A system of the tick or the input stage, or an action handler, that requires `Sound.Player` doesn't compile.

## Play music that follows the game

```ts
import { Sound, State } from "arcadekit";

const Phase = State.define("game/Phase", ["menu", "playing", "paused"]);
const Tracks = Sound.sheet("game/Tracks", { theme: "/theme.ogg" });

const Score = Sound.music(
  "game/Score",
  function* () {
    const phase = yield* State.Reader(Phase);
    if (phase.is("menu")) {
      return undefined; // silence
    }
    const { theme } = yield* Sound.Clips(Tracks);
    return { track: theme, volume: phase.is("paused") ? 0.1 : 0.4 };
  },
  { fade: 1 }
);
```

Each frame, the body returns what should play. It returns a track, a clip such as a sound of a sheet, a track with its own `volume` and `fade`, or `undefined` for silence. A track loops until the body returns another.

Nothing happens while the body returns the same thing. When it returns a different track, the first track fades out while the second fades in, over `fade` seconds. A new volume for the same track fades to it over the same time. The fade defaults to half a second.

- Music is computed from the game and stored nowhere in it. A game loaded from a save, or an app that starts in the middle of a level, has its music from the first frame.
- Use a cue, not music, for a one-off sound.
- `{ track: fanfare, once: true }` plays to its end and stops. It still counts as what the channel is playing. It doesn't restart while the body returns the same thing, and a different track fades it out if it hasn't ended. Once the body has returned something else in between, it plays again from the start.
- The body can read anything a frame system can: singletons, states, queries, events, and assets. When sound goes nowhere, the body doesn't run at all.
- Under `System.runIf`, a music system that doesn't run counts as returning silence. A level's music fades out with its configured fade when the game leaves the level, unless another system on its channel plays. When the system runs again, the body's track plays from its start.
- When the app is closed, `Sound.plugin` silences every playing channel at once.

### Play music on several channels

Every music system plays on the `"music"` channel unless given another. When a menu and a level each have a music system that runs while the game is in them, the one with something to play is heard. A track that both play continues from one to the other without restarting. Once a frame's systems have all run, the player merges what they returned for each channel. A track wins over silence, and the same track returned twice plays once.

Two systems that return different tracks for the same channel in one frame, or the same track at two volumes, are a bug. The frame fails where the second is returned, with an error that names the channel and both tracks.

Give music that plays alongside the main score its own channel, with any name, as in `Sound.music("game/Wind", body, { channel: "wind" })`. Different channels play together, and several systems can share a channel.

A frame system of your own can call `(yield* Sound.Player).music(channel, track, { volume, fade })`, which `Sound.music` is built on. It sends the output only the changes, so you can call it every frame. The output receives a change at the end of the frame, like a cue.

## Set how loud each kind of sound is

Every sound plays on a bus: a cue on `Sound.EffectsBus` and a track on `Sound.MusicBus`, unless it names another, with `bus` in its options. A frame system sets each bus's volume from the game's settings, as a settings menu needs:

```ts
import { Action, Field, Plugin, Singleton, Sound, System } from "arcadekit";
import { Schema } from "effect";

// What the player chose: a setting of the game, kept in its world.
const Settings = Singleton.define(
  "game/Settings",
  { music: Field.f32, effects: Field.bool },
  { music: 1, effects: true }
);
const Choose = Action.define("game/Choose", {
  payload: Schema.Struct({ music: Schema.Finite, effects: Schema.Boolean }),
});

const Volumes = System.frame("game/Volumes", function* () {
  const settings = yield* Singleton.Read(Settings);
  const player = yield* Sound.Player;
  player.volume(Sound.MusicBus, settings.music);
  player.volume(Sound.EffectsBus, settings.effects ? 1 : 0);
});

const Menu = Plugin.make("game/Menu", {
  plugins: [Sound.plugin],
  handlers: [
    Action.handler(Choose, function* ({ music, effects }) {
      const settings = yield* Singleton.Write(Settings);
      settings.music = music;
      settings.effects = effects;
    }),
  ],
  systems: [Volumes],
});
```

The menu's UI sends `Choose` with what the player picked, `{ music: 0.5, effects: false }` for the music at half and the effects off.

- A bus's volume scales the volume of everything on it: 1 plays it as asked, 0.5 at half, and 0 silences it. Every bus is at 1 until a system sets it, and the volume holds until it is set again, so a system can set it every frame.
- It takes effect at the end of the frame, for that frame's cues and every later one. A track that is playing is made louder or softer at once, and keeps playing from where it is.
- A bus is a value, so a bus that was never declared doesn't compile, and a game that needs only the music and the effects declares none. Declare another once, at module level, with `Sound.bus(name)`: with `const UiBus = Sound.bus("ui")`, `Sound.on(Clicked, { cue: click, bus: UiBus })` plays on it, and `Sound.music(name, body, { bus: UiBus })` plays its tracks on it.
- A page's `volume` option scales every bus, on top of their own volumes.

## Choose where sound goes

Sound follows real time and isn't part of the game. A game with sound has the same hash, log, and save as one without. A replay or a server runs no frame stage, so it plays nothing.

`Sound.Output` is where sound goes: how to open a speaker. It is a `Context.Reference` whose default goes nowhere, and then the cue system reads nothing. `Sound.plugin` opens the output when the app is made, and lets go of the speaker when the app is closed. `Sound.layer(speaker)` provides a speaker made by hand, open already. A test provides `Sound.makeRecorder()`, which plays nothing and records what it was asked. It records the cues in `played`, what each channel was told in `scored`, and what each channel plays now in `playing`. See [testing](testing.md#record-the-sound).

A system that asks for a sheet's clips has the sheet's `Sound.Plays` in its type, and so has the game, and only what says where the sound goes provides it. A page provides it for each sheet in its `sounds`, so a page not given one [doesn't compile](sound-in-a-page.md#give-the-page-its-cue-sheets). `Sound.layer(speaker)` and `Test.make` provide it for every sheet, and so does `Sound.layerNowhere`, which a server or a replay of such a game provides.

A recorder records a sound of a sheet by its name, a sheet's `coin` as `"coin"`, at the volume it was played at, its bus's included. `Sound.clip(name, data)` makes a clip by hand, for a speaker of your own or for a test, which needs nothing to play. A recorder records such a clip by its `name`, with the clip itself as `clip`.

## Keep stepping after a failed frame

When a frame fails, what it set for a channel stays in place until a frame completes. In the next frame, a system that sets something different for that channel is refused, as if two systems had set it at once. The exception is a frame that failed on that conflict itself. A game under a driver stops at a failed frame, so only a test that keeps stepping after one meets the refusal.

## Play sound under rollback

In a multiplayer game played with [rollback](sessions.md), a tick can run again. A cue that the second run plays with the same payload plays once, because the frame stage hears each event once however often a session runs its tick. A cue that only the second run plays, or plays with another payload, plays then. A sound for something that is later rolled back has already played, and keeps playing. A game that must not play sounds early checks `session.confirmed`.

## Read more

- [Playing sound in a page](sound-in-a-page.md).
- [`Sound`](/reference/arcadekit/Sound) in the API reference.
