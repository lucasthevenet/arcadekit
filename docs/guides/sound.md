# Sound

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

- `Sound.cues` makes a system of the frame stage. Each frame it plays what the events since the last frame sound like.
- `Sound.on(event, cue)` is a line: a cue's name, a name with a `volume` and a `rate`, or a function of the payload that gives either, or nothing.
- A cue asked for several times in one frame is played once, as the loudest asked: forty coins caught in one tick are one sound.
- A frame system can play a sound no event stands for: `(yield* Sound.Player).play("click")`. In a tick that throws.

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

Each frame, the body says what should play. Nothing happens while it says the same. When it says another track, the first fades out and the second fades in, over `fade` seconds.

- It is worked out from the game and kept nowhere in it, so a game loaded from a save has its music from its first frame.
- `{ track: "fanfare", once: true }` plays to its end and no further.
- Every music system is on the channel `"music"` unless given another, `{ channel: "wind" }`. Channels play together.
- Under `System.runIf`, a music system that doesn't run says nothing should play, so a level's music stops when the level is left.

## A level's own sounds

A level's sounds are assets of its bundle, `Browser.sound(url)`, loaded when the game enters it and let go when it leaves. A loaded sound is a `Sound.Clip`, which goes wherever a cue's or a track's name goes:

```ts sketch
const ForestCues = Sound.cues("forest/Cues", Forest, ({ creak }) => [
  Sound.on(Stepped, ({ hard }) => ({ cue: creak, volume: hard ? 1 : 0.4 })),
]);
```

While the bundle isn't loaded, its cues play nothing. Both need `Assets.plugin`. See [assets](assets.md).

## In a page

The output is Web Audio, which `Browser.runMain` provides. `sounds` gives the page's own files by name. A long piece of music is streamed with `Browser.stream(url)` instead of decoded whole.

- A page may not make a sound before its user has touched it. A cue asked for before that is not played, and the first one is logged once, so a game that opens with a sound is told why it isn't heard. Music that was asked for starts as soon as it can.
- While the page is hidden, its audio sleeps.
- `sounds: false` is a page with no sound.

## Heard or not, the same game

A game that is heard has the same hash, log and save as one that is not. A replay or a server plays nothing. A test records what would be played with `Sound.makeRecorder()`. See [testing](testing.md).

## Read more

- [Sound](../../packages/arcadekit/README.md#sound) and [music](../../packages/arcadekit/README.md#music) in the reference, with what is not done: a cue that can be stopped, sound heard from where it is, music in time.
