// A game with a settings menu: a coin sounds when one is caught, a theme
// plays, and the player chooses how loud the music is and whether the effects
// are heard. Played by test/Sound.test.ts with a recorder, and by
// test/Browser.test.ts through a page's audio.
import { Schema } from "effect";

import {
  Action,
  App,
  Event,
  Field,
  Plugin,
  Singleton,
  Sound,
  System,
} from "../src/index.ts";

/** The game's sounds: a cue and a track. */
export const Sfx = Sound.sheet("vm/Sfx", {
  coin: "/coin.wav",
  theme: "/thud.wav",
});

/** What the player chose in the menu: a setting of the game, kept in its world. */
export const Settings = Singleton.define(
  "vm/Settings",
  { music: Field.f32, effects: Field.u8 },
  { music: 1, effects: 1 }
);
export const Choose = Action.define(
  "vm/Choose",
  Schema.Struct({ music: Schema.Finite, effects: Schema.Boolean })
);
export const Catch = Action.define("vm/Catch", Schema.Struct({}));
const Caught = Event.define("vm/Caught");

const Rules = Plugin.make("vm/Rules", {
  handlers: [
    Action.handler(Choose, function* ({ effects, music }) {
      const settings = yield* Settings.writes;
      settings.music = music;
      settings.effects = effects ? 1 : 0;
    }),
    Action.handler(Catch, function* () {
      (yield* Caught.emits).emit(undefined);
    }),
  ],
});

/** Each frame, the buses are as loud as the settings say. */
const Volumes = System.frame("vm/Volumes", function* () {
  const settings = yield* Settings;
  const player = yield* Sound.Player;
  player.volume(Sound.MusicBus, settings.music);
  player.volume(Sound.EffectsBus, settings.effects === 1 ? 1 : 0);
});

export const Game = App.define({
  plugins: [Rules, Sound.plugin],
  systems: [
    Volumes,
    Sound.cues("vm/Cues", Sfx, ({ coin }) => [Sound.on(Caught, coin)]),
    Sound.music("vm/Score", function* () {
      return (yield* Sfx).theme;
    }),
  ],
});
