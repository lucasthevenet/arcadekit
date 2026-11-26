import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";

import {
  Action,
  App,
  Assets,
  Event,
  Field,
  Plugin,
  Replay,
  Save,
  Singleton,
  Sound,
  State,
  System,
  World,
} from "../src/index.ts";
import type { BuiltIn } from "../src/Services.ts";
import { thrown } from "./checks.ts";

// --- a game of levels, which knows nothing of sound ---------------------------------
const Level = State.define("mu/Level", ["menu", "forest", "cave"]);
/** Whether the game is hushed: paused, say. */
const Hush = Singleton.define("mu/Hush", { on: Field.u8 }, { on: 0 });
const Stepped = Event.define(
  "mu/Stepped",
  Schema.Struct({ hard: Schema.Boolean })
);

const Go = Action.define(
  "mu/Go",
  Schema.Struct({ to: Schema.Literals(["menu", "forest", "cave"]) })
);
const SetHush = Action.define(
  "mu/SetHush",
  Schema.Struct({ on: Schema.Boolean })
);
const Step = Action.define("mu/Step", Schema.Struct({ hard: Schema.Boolean }));

const Rules = Plugin.make("mu/Rules", {
  handlers: [
    Action.handler(Go, function* ({ to }) {
      (yield* Level.sets).set(to);
    }),
    Action.handler(SetHush, function* ({ on }) {
      (yield* Hush.writes).on = on ? 1 : 0;
    }),
    Action.handler(Step, function* ({ hard }) {
      (yield* Stepped.emits).emit({ hard });
    }),
  ],
});

// --- what it sounds like -------------------------------------------------------------
/** The game's tracks and cues, by the names a recorder records them by. */
const T = Sound.sheet("mu/Tracks", {
  a: "/a.ogg",
  b: "/b.ogg",
  breeze: "/breeze.ogg",
  click: "/click.ogg",
  buzz: "/buzz.ogg",
  calm: "/calm.ogg",
  drip: "/drip.ogg",
  drone: "/drone.ogg",
  fanfare: "/fanfare.ogg",
  hiss: "/hiss.ogg",
  hum: "/hum.ogg",
  tap: "/tap.ogg",
  theme: "/theme.ogg",
  wind: "/wind.ogg",
});
/** How often the score was asked what should be playing. */
let asked = 0;
const Score = Sound.music(
  "mu/Score",
  function* () {
    asked++;
    const level = (yield* Level).value;
    if (level === "menu") {
      return undefined;
    }
    if ((yield* Hush).on === 1) {
      return { track: T.theme, volume: 0.2 };
    }
    // The cave has a track of its own, quieter and slower to come.
    return level === "forest"
      ? T.theme
      : { track: T.drip, volume: 0.5, fade: 2 };
  },
  { fade: 1 }
);

/** An app, which the test closes when it likes. */
const start = Effect.fnUntraced(function* <
  A extends { readonly close: Effect.Effect<void> },
  E,
>(make: Effect.Effect<A, E>, output?: Sound.Speaker) {
  const provided =
    output === undefined
      ? make
      : make.pipe(Effect.provide(Sound.layer(output)));
  const app = yield* provided;
  return { app, close: app.close };
});

/** The plugins of the game of levels, with what plays its sound. */
const plugins = [Rules, Sound.plugin, Assets.plugin] as const;

/** A game of levels, with systems of its own. */
type Levels = App.Game<
  readonly System.System<never, BuiltIn | Sound.Player | Assets.Store>[],
  readonly [],
  typeof plugins
>;

const play = Effect.fnUntraced(function* (
  game: Levels,
  output?: Sound.Speaker
) {
  asked = 0;
  const { app, close } = yield* start(App.make(game, { hashEvery: 1 }), output);
  return {
    app,
    close,
    /** The game does something, a tick applies it, and a frame is heard. */
    step: Effect.fnUntraced(function* (action: Action.Any, payload: unknown) {
      yield* Effect.asVoid(app.dispatch(action as never, payload as never));
      yield* app.tick(0.1);
      yield* app.frame();
    }),
  };
});

describe("Sound.music", () => {
  it.effect(
    "keeps a channel playing what the game, as it is, should sound like",
    () =>
      Effect.gen(function* () {
        const sound = Sound.makeRecorder();
        const { app, step } = yield* play(
          App.define({ plugins, systems: [Score] }),
          sound
        );
        // The menu is silent, and a channel that was told nothing is not told so.
        yield* app.tick(0.1);
        yield* app.frame();
        yield* app.frame();
        expect(sound.scored).toEqual([]);
        expect(asked).toBe(2);

        yield* step(Go, { to: "forest" });
        expect(sound.scored).toEqual([
          { channel: "music", track: "theme", volume: 1, fade: 1 },
        ]);
        expect(Object.fromEntries(sound.playing)).toEqual({ music: "theme" });
        // It goes on, and nothing is said again, however many frames and ticks.
        for (let i = 0; i < 5; i++) {
          yield* app.tick(0.1);
          yield* app.frame();
          yield* app.frame(0.5);
        }
        expect(sound.scored.length).toBe(1);

        // The same track, softer.
        yield* step(SetHush, { on: true });
        expect(sound.scored.slice(1)).toEqual([
          { channel: "music", track: "theme", volume: 0.2, fade: 1 },
        ]);
        yield* step(SetHush, { on: false });
        // Another track, with a volume and a fade of its own.
        yield* step(Go, { to: "cave" });
        expect(sound.scored.slice(2)).toEqual([
          { channel: "music", track: "theme", volume: 1, fade: 1 },
          { channel: "music", track: "drip", volume: 0.5, fade: 2 },
        ]);
        expect(Object.fromEntries(sound.playing)).toEqual({ music: "drip" });

        // And silence, said once.
        yield* step(Go, { to: "menu" });
        yield* app.frame();
        yield* app.frame();
        expect(sound.scored.slice(4)).toEqual([
          { channel: "music", track: undefined, volume: 0, fade: 1 },
        ]);
        expect(sound.playing.size).toBe(0);
        // Nothing of it was a cue.
        expect(sound.played).toEqual([]);
      })
  );

  it.effect(
    "takes half a second over a change unless told otherwise, and is never below silence or back in time",
    () =>
      Effect.gen(function* () {
        const sound = Sound.makeRecorder();
        let wanted: Sound.TrackOf = T.a;
        const Plain = Sound.music("mu/Plain", function* () {
          yield* Level;
          return wanted;
        });
        const { app } = yield* play(
          App.define({ plugins, systems: [Plain] }),
          sound
        );
        yield* app.frame();
        wanted = { track: T.a, volume: -3 };
        yield* app.frame();
        wanted = { track: T.b, fade: -1 };
        yield* app.frame();
        wanted = { track: T.b, volume: 0.25, fade: 0 };
        yield* app.frame();
        wanted = undefined;
        yield* app.frame();
        expect(sound.scored).toEqual([
          { channel: "music", track: "a", volume: 1, fade: 0.5 },
          { channel: "music", track: "a", volume: 0, fade: 0.5 },
          { channel: "music", track: "b", volume: 1, fade: 0 },
          { channel: "music", track: "b", volume: 0.25, fade: 0 },
          { channel: "music", track: undefined, volume: 0, fade: 0.5 },
        ]);
      })
  );

  it.effect(
    "plays a track once when the body says so, and not again while it says the same",
    () =>
      Effect.gen(function* () {
        const sound = Sound.makeRecorder();
        // A fanfare in the cave, for as long as the game is there; hushed, the
        // same piece goes round and round, softly.
        const Fanfare = Sound.music("mu/Fanfare", function* () {
          if ((yield* Level).value !== "cave") {
            return undefined;
          }
          return (yield* Hush).on === 1
            ? { track: T.fanfare, volume: 0.5 }
            : { track: T.fanfare, once: true };
        });
        const { app, step } = yield* play(
          App.define({ plugins, systems: [Fanfare] }),
          sound
        );
        yield* step(Go, { to: "cave" });
        expect(sound.scored).toEqual([
          {
            channel: "music",
            track: "fanfare",
            volume: 1,
            fade: 0.5,
            once: true,
          },
        ]);
        // However long after: it has ended by now, and is not begun again.
        for (let i = 0; i < 20; i++) {
          yield* app.tick(0.1);
          yield* app.frame();
        }
        expect(sound.scored.length).toBe(1);
        // Over and over is another thing to be told, of the same track.
        yield* step(SetHush, { on: true });
        expect(sound.scored.slice(1)).toEqual([
          { channel: "music", track: "fanfare", volume: 0.5, fade: 0.5 },
        ]);
        // Once again, at the same volume, is told too.
        const Twice = Sound.music("mu/Twice", function* () {
          return (yield* Hush).on === 1
            ? { track: T.fanfare, once: true }
            : T.fanfare;
        });
        const other = Sound.makeRecorder();
        const second = yield* play(
          App.define({ plugins, systems: [Twice] }),
          other
        );
        yield* second.app.frame();
        yield* second.step(SetHush, { on: true });
        expect(other.scored.map((one) => one.once)).toEqual([undefined, true]);
        // Left and come back to, it plays again from its start.
        yield* step(Go, { to: "menu" });
        yield* step(SetHush, { on: false });
        yield* step(Go, { to: "cave" });
        expect(sound.scored.slice(2)).toEqual([
          { channel: "music", track: undefined, volume: 0, fade: 0.5 },
          {
            channel: "music",
            track: "fanfare",
            volume: 1,
            fade: 0.5,
            once: true,
          },
        ]);
      })
  );

  it.effect(
    "is worked out from the game and kept nowhere in it: a game that is loaded has its music from its first frame, and is the same game as one with none",
    () =>
      Effect.gen(function* () {
        const sound = Sound.makeRecorder();
        const heard = yield* play(
          App.define({ plugins, systems: [Score] }),
          sound
        );
        // The rules alone: no output, and no system that plays.
        const deaf = yield* start(
          App.make(App.define({ plugins: [Rules] }), { hashEvery: 1 })
        );
        for (const app of [heard.app, deaf.app]) {
          yield* app.dispatch(Go, { to: "cave" });
          yield* app.dispatch(SetHush, { on: true });
          yield* app.tick(0.1);
        }
        yield* heard.app.frame();
        const hashOf = Effect.fnUntraced(function* (app: App.Any) {
          return (yield* app.read(World)).hash();
        });
        expect(yield* hashOf(heard.app)).toBe(yield* hashOf(deaf.app));
        expect(heard.app.actionLog).toEqual(deaf.app.actionLog);
        const saves = [
          yield* Effect.exit(Save.make(heard.app)),
          yield* Effect.exit(Save.make(deaf.app)),
        ].map((save) => (Exit.isSuccess(save) ? save.value : undefined));
        expect(saves[0]).toBeDefined();
        expect(saves[0]).toEqual(saves[1]);

        // Loaded elsewhere, it is in the cave and hushed, and sounds like it.
        const again = Sound.makeRecorder();
        const loaded = yield* start(
          App.make(
            App.define({ plugins: [Rules, Sound.plugin], systems: [Score] }),
            { save: saves[0]! }
          ),
          again
        );
        expect(again.scored).toEqual([]);
        yield* loaded.app.frame();
        expect(again.scored).toEqual([
          { channel: "music", track: "theme", volume: 0.2, fade: 1 },
        ]);
        // And a replay, which runs no frame, is silent.
        const replayed = Sound.makeRecorder();
        const played = yield* Replay.record(heard.app);
        const other = yield* start(
          Replay.verify(played, App.define({ plugins, systems: [Score] }), {
            hashEvery: 1,
          }),
          replayed
        );
        expect(yield* hashOf(other.app)).toBe(yield* hashOf(heard.app));
        expect(replayed.scored).toEqual([]);
      })
  );

  it.effect(
    "is one score, of which the system that has something to play is heard, and a track both play goes on",
    () =>
      Effect.gen(function* () {
        // A menu's music and a level's, each a system of its own that runs
        // while the game is there: two that are meant as one score.
        const MenuScore = Sound.music("mu/MenuScore", function* () {
          yield* Level;
          return T.theme;
        }).pipe(System.runIf(State.is(Level, "menu")));
        const LevelScore = Sound.music("mu/LevelScore", function* () {
          return (yield* Level).value === "forest" ? T.theme : T.drip;
        }).pipe(System.runIf(State.is(Level, "forest", "cave")));
        // Whichever of the two is listed first: silence gives way to a track.
        for (const game of [
          App.define({ plugins, systems: [MenuScore, LevelScore] }),
          App.define({ plugins, systems: [LevelScore, MenuScore] }),
        ]) {
          const sound = Sound.makeRecorder();
          const { app, step } = yield* play(game, sound);
          yield* app.frame();
          expect(sound.scored).toEqual([
            { channel: "music", track: "theme", volume: 1, fade: 0.5 },
          ]);
          // Into the forest, whose track is the menu's: it goes on, and the
          // output is told nothing.
          yield* step(Go, { to: "forest" });
          expect(sound.scored.length).toBe(1);
          yield* step(Go, { to: "cave" });
          yield* step(Go, { to: "menu" });
          expect(sound.scored.slice(1)).toEqual([
            { channel: "music", track: "drip", volume: 1, fade: 0.5 },
            { channel: "music", track: "theme", volume: 1, fade: 0.5 },
          ]);
          expect(Object.fromEntries(sound.playing)).toEqual({ music: "theme" });
        }
      })
  );

  it.effect(
    "is a bug when two systems of one channel say two things in one frame, which the frame says",
    () =>
      Effect.gen(function* () {
        const sound = Sound.makeRecorder();
        // The first to speak says another thing when the game is hushed.
        const One = Sound.music("mu/One", function* () {
          return (yield* Hush).on === 1 ? T.calm : T.theme;
        });
        let other: Sound.TrackOf = T.wind;
        const Two = Sound.music("mu/Two", function* () {
          return (yield* Hush).on === 1 ? undefined : other;
        });
        const { app, step } = yield* play(
          App.define({ plugins, systems: [One, Two] }),
          sound
        );
        const refused = (first: string, second: string) =>
          `The channel "music" was told to play two things in one frame: ${first} and ${second}. A channel plays one track at a time. The systems made with Sound.music share the channel "music" unless they name another: they are one score, of which one says what plays. For two that play together, music and the wind, give one a channel of its own: Sound.music(name, body, { channel: "wind" }).`;
        expect(yield* thrown(app.frame())).toThrow(
          refused('"theme"', '"wind"')
        );
        // One track at two volumes is two things, and so is once and over and over.
        other = { track: T.theme, volume: 0.2 };
        expect(yield* thrown(app.frame())).toThrow(
          refused('"theme"', '"theme" at 0.2')
        );
        other = { track: T.theme, once: true };
        expect(yield* thrown(app.frame())).toThrow(
          refused('"theme"', '"theme", once')
        );
        other = Sound.clip("/theme.ogg");
        expect(yield* thrown(app.frame())).toThrow(
          refused('"theme"', '"/theme.ogg"')
        );
        // Nothing of it reached the output.
        expect(sound.scored).toEqual([]);
        // Put right, the next frame is heard, and what the failed one said is
        // not held against it.
        yield* step(SetHush, { on: true });
        expect(sound.scored).toEqual([
          { channel: "music", track: "calm", volume: 1, fade: 0.5 },
        ]);
        // The same thing said by both is said once.
        other = { track: T.theme, fade: 3 };
        yield* step(SetHush, { on: false });
        expect(sound.scored.slice(1)).toEqual([
          { channel: "music", track: "theme", volume: 1, fade: 0.5 },
        ]);
      })
  );

  it.effect(
    "plays beside the score on a channel of its own, which several systems can share too",
    () =>
      Effect.gen(function* () {
        const sound = Sound.makeRecorder();
        const Wind = Sound.music(
          "mu/Wind",
          function* () {
            return (yield* Level).value === "menu"
              ? undefined
              : { track: T.wind, volume: 0.3 };
          },
          { channel: "wind" }
        );
        // Another of the wind's channel, which only the menu hears.
        const Breeze = Sound.music(
          "mu/Breeze",
          function* () {
            return (yield* Level).value === "menu" ? T.breeze : undefined;
          },
          { channel: "wind", fade: 4 }
        );
        const { app, step } = yield* play(
          App.define({ plugins, systems: [Score, Wind, Breeze] }),
          sound
        );
        yield* app.frame();
        expect(sound.scored).toEqual([
          { channel: "wind", track: "breeze", volume: 1, fade: 4 },
        ]);
        yield* step(Go, { to: "forest" });
        expect(Object.fromEntries(sound.playing)).toEqual({
          music: "theme",
          wind: "wind",
        });
        // Channels are told in the order they were first heard of.
        expect(sound.scored.slice(1)).toEqual([
          { channel: "wind", track: "wind", volume: 0.3, fade: 0.5 },
          { channel: "music", track: "theme", volume: 1, fade: 1 },
        ]);
      })
  );

  it.effect("is one channel per name, and several play together", () =>
    Effect.gen(function* () {
      const sound = Sound.makeRecorder();
      const Wind = Sound.music(
        "mu/Wind",
        function* () {
          return (yield* Level).value === "menu"
            ? undefined
            : { track: T.wind, volume: 0.3 };
        },
        { channel: "mu/Wind" }
      );
      const { step } = yield* play(
        App.define({ plugins, systems: [Score, Wind] }),
        sound
      );
      yield* step(Go, { to: "forest" });
      expect(Object.fromEntries(sound.playing)).toEqual({
        music: "theme",
        "mu/Wind": "wind",
      });
      expect(sound.scored.length).toBe(2);
      // The score changes, and the wind is not told anything.
      yield* step(Go, { to: "cave" });
      expect(sound.scored.slice(2)).toEqual([
        { channel: "music", track: "drip", volume: 0.5, fade: 2 },
      ]);
      expect(Object.fromEntries(sound.playing)).toEqual({
        music: "drip",
        "mu/Wind": "wind",
      });
    })
  );

  it.effect("works nothing out where sound goes nowhere", () =>
    Effect.gen(function* () {
      const { app, step } = yield* play(
        App.define({ plugins, systems: [Score] })
      );
      yield* step(Go, { to: "forest" });
      yield* app.frame();
      expect(asked).toBe(0);
      // Somewhere to go, it is asked each frame.
      const heard = yield* play(
        App.define({ plugins, systems: [Score] }),
        Sound.makeRecorder()
      );
      yield* heard.app.frame();
      yield* heard.app.frame();
      expect(asked).toBe(2);
    })
  );

  it.effect(
    "is silent while its system does not run, as if the body had said so, and says what plays when it runs again",
    () =>
      Effect.gen(function* () {
        const sound = Sound.makeRecorder();
        const Gated = Score.pipe(
          System.runIf(Effect.map(Hush, (hush) => hush.on === 0))
        );
        const { app, step } = yield* play(
          App.define({ plugins, systems: [Gated] }),
          sound
        );
        yield* step(Go, { to: "forest" });
        expect(Object.fromEntries(sound.playing)).toEqual({ music: "theme" });
        // Hushed, the system is not run: its music stops, with the fade it
        // was given, and the body, which would have said a volume of 0.2, is
        // not asked.
        const before = asked;
        yield* step(SetHush, { on: true });
        yield* app.frame();
        yield* app.frame();
        expect(asked).toBe(before);
        expect(sound.scored).toEqual([
          { channel: "music", track: "theme", volume: 1, fade: 1 },
          { channel: "music", track: undefined, volume: 0, fade: 1 },
        ]);
        expect(sound.playing.size).toBe(0);
        // Run again, it says what is so now.
        yield* step(SetHush, { on: false });
        expect(sound.scored.slice(2)).toEqual([
          { channel: "music", track: "theme", volume: 1, fade: 1 },
        ]);
        // A system that was never run has nothing to stop.
        const other = Sound.makeRecorder();
        const never = yield* play(
          App.define({
            plugins,
            systems: [Score.pipe(System.runIf(Effect.succeed(false)))],
          }),
          other
        );
        yield* never.step(Go, { to: "forest" });
        expect(other.scored).toEqual([]);
        // And where nothing is heard, nothing is said.
        const deaf = yield* play(App.define({ plugins, systems: [Gated] }));
        yield* deaf.step(SetHush, { on: true });
        expect(asked).toBe(0);
      })
  );

  it.effect(
    "leaves nothing playing when the app goes: every channel that was playing is told silence, at once",
    () =>
      Effect.gen(function* () {
        const sound = Sound.makeRecorder();
        const Wind = Sound.music(
          "mu/Wind",
          function* () {
            return (yield* Level).value === "cave" ? undefined : T.wind;
          },
          { channel: "wind" }
        );
        const Never = Sound.music(
          "mu/Never",
          function* () {
            yield* Level;
            return undefined;
          },
          { channel: "never" }
        );
        const { close, step } = yield* play(
          App.define({ plugins, systems: [Score, Wind, Never] }),
          sound
        );
        yield* step(Go, { to: "forest" });
        // The wind stops of itself in the cave; the score is still playing.
        yield* step(Go, { to: "cave" });
        const before = sound.scored.length;
        yield* close;
        expect(sound.scored.slice(before)).toEqual([
          { channel: "music", track: undefined, volume: 0, fade: 0 },
        ]);
        expect(sound.playing.size).toBe(0);
      })
  );

  it("gives a track or nothing, and needs Sound.plugin: anything else does not compile", () => {
    // @ts-expect-error a number is no track
    Sound.music("mu/Wrong", function* () {
      yield* Level;
      return 3;
    });
    const made = App.make(App.define({ plugins: [Rules], systems: [Score] }));
    // The app still needs the player, which Sound.plugin gives.
    expectTypeOf<Effect.Services<typeof made>>().toEqualTypeOf<Sound.Player>();
    expect(Score.name).toBe("mu/Score");
    expect(Score.stage).toBe("frame");
  });
});

describe("Sound.Player.music", () => {
  it("is never called by the simulation: a tick system or a handler cannot play", () => {
    System.tick(
      "mu/Loud",
      // @ts-expect-error sound is the frame's
      function* () {
        (yield* Sound.Player).music("mu/Loud", T.theme);
      }
    );
    const Bang = Action.define("mu/Bang", Schema.Struct({}));
    Action.handler(
      Bang,
      // @ts-expect-error sound is the frame's
      function* () {
        (yield* Sound.Player).music("mu/Bang", undefined);
      }
    );
    expect(Bang.name).toBe("mu/Bang");
  });

  it.effect(
    "makes one thing of what a frame says of a channel: a track over silence, and the fade of the one that is heard",
    () =>
      Effect.gen(function* () {
        const sound = Sound.makeRecorder();
        let says: (readonly [
          string,
          keyof typeof T | undefined,
          Sound.MusicOptions?,
        ])[] = [];
        const Say = System.frame("mu/Say", function* () {
          const player = yield* Sound.Player;
          for (const [channel, track, options] of says) {
            player.music(
              channel,
              track === undefined ? undefined : T[track],
              options
            );
          }
        });
        const { app } = yield* start(
          App.make(App.define({ plugins: [Sound.plugin], systems: [Say] })),
          sound
        );
        const frame = Effect.fnUntraced(function* (...said: typeof says) {
          says = said;
          const before = sound.scored.length;
          yield* app.frame();
          return sound.scored.slice(before);
        });
        // Silence first or last, the track is what the channel plays, as the
        // one that said it would have it: its volume, its fade.
        expect(
          yield* frame(
            ["a", undefined, { fade: 9 }],
            ["a", "hum", { volume: 0.4, fade: 2 }],
            ["b", "buzz", { fade: 3 }],
            ["b", undefined, { fade: 9 }],
            ["a", undefined]
          )
        ).toEqual([
          { channel: "a", track: "hum", volume: 0.4, fade: 2 },
          { channel: "b", track: "buzz", volume: 1, fade: 3 },
        ]);
        // Said twice the same, with whatever fade, it is said once: the first.
        expect(
          yield* frame(
            ["a", "drone", { fade: 1 }],
            ["a", "drone", { fade: 7 }],
            ["b", "buzz"]
          )
        ).toEqual([{ channel: "a", track: "drone", volume: 1, fade: 1 }]);
        // Silence from all who speak is silence, with the fade of the first.
        expect(
          yield* frame(
            ["a", undefined, { fade: 6 }],
            ["a", undefined, { fade: 1 }]
          )
        ).toEqual([{ channel: "a", track: undefined, volume: 0, fade: 6 }]);
        // A channel nobody speaks of plays on.
        expect(yield* frame()).toEqual([]);
        expect(Object.fromEntries(sound.playing)).toEqual({ b: "buzz" });
        // Two things of one channel throw where the second is said, and name
        // it; the other channel is not held up by it next frame.
        expect(
          yield* thrown(frame(["b", "buzz"], ["b", "hiss"], ["a", "hum"]))
        ).toThrow(
          'The channel "b" was told to play two things in one frame: "buzz" and "hiss".'
        );
        expect(yield* frame(["b", "hiss"])).toEqual([
          { channel: "b", track: "hiss", volume: 1, fade: 0.5 },
        ]);
        // On a channel that is playing, too: silence first, and the track's
        // own fade is the one that is used.
        expect(
          yield* frame(
            ["b", undefined, { fade: 9 }],
            ["b", "buzz", { fade: 3 }]
          )
        ).toEqual([{ channel: "b", track: "buzz", volume: 1, fade: 3 }]);
        // What a refused frame said first is not told later, when nobody
        // speaks of the channel: it plays on as it was.
        expect(yield* thrown(frame(["b", "hiss"], ["b", "drone"]))).toThrow(
          '"hiss" and "drone"'
        );
        expect(yield* frame()).toEqual([]);
        expect(yield* frame(["a", "hum"])).toEqual([
          { channel: "a", track: "hum", volume: 1, fade: 0.5 },
        ]);
        expect(Object.fromEntries(sound.playing)).toEqual({
          a: "hum",
          b: "buzz",
        });
      })
  );

  it.effect(
    "forgets what a frame said of a channel when another system failed it",
    () =>
      Effect.gen(function* () {
        const sound = Sound.makeRecorder();
        let track = T.hum;
        let failing = true;
        const Say = System.frame("mu/Say", function* () {
          (yield* Sound.Player).music("a", track);
        });
        const Fail = System.frame("mu/Fail", function* () {
          if (failing) {
            return yield* Effect.fail("broken");
          }
        });
        const { app } = yield* start(
          App.make(
            App.define({ plugins: [Sound.plugin], systems: [Say, Fail] })
          ),
          sound
        );
        expect(yield* thrown(app.frame())).toThrow("broken");
        failing = false;
        track = T.drone;
        yield* app.frame();
        expect(sound.scored).toEqual([
          { channel: "a", track: "drone", volume: 1, fade: 0.5 },
        ]);
      })
  );

  it.effect(
    "is heard in the same frame as the frame's cues, each as it was asked",
    () =>
      Effect.gen(function* () {
        const sound = Sound.makeRecorder();
        let on = false;
        const Both = System.frame("mu/Both", function* () {
          const player = yield* Sound.Player;
          player.play(T.click, { volume: 0.5 });
          player.music("ui", on ? T.hum : undefined);
        });
        const { app } = yield* start(
          App.make(App.define({ plugins: [Sound.plugin], systems: [Both] })),
          sound
        );
        // A cue alone, while the channel has never played.
        yield* app.frame();
        expect(sound.played).toEqual([{ cue: "click", volume: 0.5, rate: 1 }]);
        expect(sound.scored).toEqual([]);
        // A cue and a track; and a cue while the track goes on.
        on = true;
        yield* app.frame();
        yield* app.frame();
        expect(sound.played.length).toBe(3);
        expect(sound.scored).toEqual([
          { channel: "ui", track: "hum", volume: 1, fade: 0.5 },
        ]);
      })
  );

  it.effect(
    "tells the output of a change and of nothing else, for a system of the frame stage",
    () =>
      Effect.gen(function* () {
        const sound = Sound.makeRecorder();
        const said: (readonly [
          keyof typeof T | undefined,
          Sound.MusicOptions?,
        ])[] = [];
        let next:
          | readonly [keyof typeof T | undefined, Sound.MusicOptions?]
          | undefined;
        const Hum = System.frame("mu/Hum", function* () {
          if (next !== undefined) {
            said.push(next);
            (yield* Sound.Player).music(
              "ui",
              next[0] === undefined ? undefined : T[next[0]],
              next[1]
            );
          }
        });
        const { app } = yield* start(
          App.make(
            App.define({
              plugins: [Sound.plugin],
              systems: [Hum],
            })
          ),
          sound
        );
        const say = Effect.fnUntraced(function* (
          track: keyof typeof T | undefined,
          options?: Sound.MusicOptions
        ) {
          next = options === undefined ? [track] : [track, options];
          const before = sound.scored.length;
          yield* app.frame();
          next = undefined;
          return sound.scored.length - before;
        });
        // Silence, said to a channel that never played, is said to nobody.
        expect(yield* say(undefined)).toBe(0);
        expect(yield* say("hum", { volume: 0.3, fade: 0 })).toBe(1);
        // The same again, and the same with another fade, are no change.
        expect(yield* say("hum", { volume: 0.3, fade: 0 })).toBe(0);
        expect(yield* say("hum", { volume: 0.3, fade: 9 })).toBe(0);
        expect(yield* say("hum", { volume: 0.6 })).toBe(1);
        expect(yield* say("buzz", { volume: 0.6 })).toBe(1);
        expect(yield* say(undefined, { fade: 2 })).toBe(1);
        expect(yield* say(undefined)).toBe(0);
        expect(yield* say("buzz")).toBe(1);
        // Once, and over and over, are two things to be told of one track;
        // each said again is no change, and silence is neither.
        expect(yield* say("buzz", { once: true })).toBe(1);
        expect(yield* say("buzz", { once: true })).toBe(0);
        expect(yield* say("buzz", { once: false })).toBe(1);
        expect(yield* say("buzz")).toBe(0);
        expect(yield* say(undefined, { once: true })).toBe(1);
        expect(yield* say(undefined)).toBe(0);
        expect(sound.scored).toEqual([
          { channel: "ui", track: "hum", volume: 0.3, fade: 0 },
          { channel: "ui", track: "hum", volume: 0.6, fade: 0.5 },
          { channel: "ui", track: "buzz", volume: 0.6, fade: 0.5 },
          { channel: "ui", track: undefined, volume: 0, fade: 2 },
          { channel: "ui", track: "buzz", volume: 1, fade: 0.5 },
          { channel: "ui", track: "buzz", volume: 1, fade: 0.5, once: true },
          { channel: "ui", track: "buzz", volume: 1, fade: 0.5 },
          { channel: "ui", track: undefined, volume: 0, fade: 0.5 },
        ]);
        expect(said.length).toBe(15);
      })
  );
});

// --- a level's own sounds -------------------------------------------------------------

/** A forest whose sounds are clips, each loading a clip of its own. */
const makeForest = () => {
  const clips: Sound.Clip[] = [];
  const clipAt = (url: string) =>
    Assets.make(url, (_bytes, at) =>
      Effect.sync(() => {
        const clip = Sound.clip(at, { loaded: clips.length });
        clips.push(clip);
        return clip;
      })
    );
  const Forest = Assets.bundle("mu/Forest", {
    creak: clipAt("/creak.wav"),
    wind: clipAt("/wind.ogg"),
  });
  const Keep = Assets.during(Forest).pipe(
    System.runIf(State.is(Level, "forest"))
  );
  return { Forest, Keep, clips };
};
const files = Assets.layer(
  Assets.makeMemory({ "/creak.wav": "c", "/wind.ogg": "w" })
);

describe("a clip", () => {
  it.effect(
    "is played wherever a cue's name is, and is the sound it is, whatever it is called",
    () =>
      Effect.gen(function* () {
        const sound = Sound.makeRecorder();
        const creak = Sound.clip("creak");
        const other = Sound.clip("creak");
        const Cues = Sound.cues(
          "mu/Cues",
          Sound.on(Stepped, ({ hard }) =>
            hard ? { cue: creak, volume: 0.9, rate: 2 } : creak
          ),
          Sound.on(Stepped, ({ hard }) => (hard ? other : undefined)),
          Sound.on(Stepped, T.tap)
        );
        const { app } = yield* play(
          App.define({ plugins, systems: [Cues] }),
          sound
        );
        yield* app.dispatch(Step, { hard: false });
        yield* app.dispatch(Step, { hard: false });
        yield* app.tick(0.1);
        yield* app.frame();
        // Two steps of one frame are one creak and one tap.
        expect(sound.played).toEqual([
          { cue: "creak", volume: 1, rate: 1, clip: creak },
          { cue: "tap", volume: 1, rate: 1 },
        ]);
        expect(sound.played[0]!.clip).toBe(creak);
        sound.played.length = 0;
        yield* app.dispatch(Step, { hard: true });
        yield* app.dispatch(Step, { hard: false });
        yield* app.tick(0.1);
        yield* app.frame();
        // The louder of the two asks for the one clip wins; another clip of
        // the same name is another sound.
        expect(
          sound.played.map((one) => [one.clip, one.volume, one.rate])
        ).toEqual([
          [creak, 1, 1],
          [other, 1, 1],
          [undefined, 1, 1],
        ]);
        expect(sound.played[1]!.clip).toBe(other);
      })
  );

  it("is named when it is played or set in the tick, which does not compile", () => {
    System.tick(
      "mu/LoudClip",
      // @ts-expect-error sound is the frame's
      function* () {
        (yield* Sound.Player).play(Sound.clip("/bang.wav"));
      }
    );
    expect(Sound.clip("/bang.wav").name).toBe("/bang.wav");
  });
});

describe("a level's cues", () => {
  it.effect(
    "are made of what its bundle holds, once each time it is loaded, and play nothing while it is not",
    () =>
      Effect.gen(function* () {
        const sound = Sound.makeRecorder();
        const { Forest, Keep, clips } = makeForest();
        let made = 0;
        const ForestCues = Sound.cues("mu/ForestCues", Forest, ({ creak }) => {
          made++;
          return [
            Sound.on(Stepped, ({ hard }) => ({
              cue: creak,
              volume: hard ? 1 : 0.4,
            })),
          ];
        });
        asked = 0;
        const { app } = yield* start(
          App.make(
            App.define({
              plugins: [Rules, Sound.plugin, Assets.plugin], // Listed after the cues it is for: it is of an earlier stage.
              systems: [ForestCues, Keep],
            })
          ).pipe(Effect.provide(files)),
          sound
        );
        const step = Effect.fnUntraced(function* (
          action: Action.Any,
          payload: unknown
        ) {
          yield* Effect.asVoid(app.dispatch(action as never, payload as never));
          yield* app.tick(0.1);
          yield* app.frame();
        });
        // In the menu the forest's sounds are not loaded.
        yield* step(Step, { hard: true });
        expect(sound.played).toEqual([]);
        expect(made).toBe(0);
        // A step in the very tick the forest is entered is heard: by the frame
        // after, its sounds are there.
        yield* app.dispatch(Step, { hard: true });
        yield* step(Go, { to: "forest" });
        expect(made).toBe(1);
        expect(clips.length).toBe(2);
        expect(sound.played).toEqual([
          { cue: "/creak.wav", volume: 1, rate: 1, clip: clips[0] },
        ]);
        yield* step(Step, { hard: false });
        yield* app.frame();
        yield* app.frame();
        expect(sound.played.slice(1)).toEqual([
          { cue: "/creak.wav", volume: 0.4, rate: 1, clip: clips[0] },
        ]);
        expect(made).toBe(1);

        // Left: nothing of the forest is played, and what happened meanwhile
        // is not played when it is entered again.
        yield* step(Go, { to: "cave" });
        yield* step(Step, { hard: true });
        expect(sound.played.length).toBe(2);
        yield* step(Go, { to: "forest" });
        expect(sound.played.length).toBe(2);
        expect(made).toBe(2);
        // Loaded again, its lines are made of what is loaded now.
        yield* step(Step, { hard: true });
        expect(clips.length).toBe(4);
        expect(sound.played.at(-1)!.clip).toBe(clips[2]);
        expect(sound.played.length).toBe(3);
      })
  );

  it.effect(
    "are made anew in the frame the bundle is found loaded afresh, though it was never seen gone",
    () =>
      Effect.gen(function* () {
        const sound = Sound.makeRecorder();
        const { Forest, clips } = makeForest();
        let made = 0;
        const ForestCues = Sound.cues("mu/ForestCues", Forest, ({ creak }) => {
          made++;
          return [Sound.on(Stepped, creak)];
        });
        // A system of the game's own keeps the forest, and can load it afresh.
        let afresh = false;
        const Keep = System.frame("mu/Keep", function* () {
          const store = yield* Assets.Store;
          if (afresh) {
            afresh = false;
            store.drop(Forest, "mu/Keep");
          }
          store.hold(Forest, "mu/Keep");
        });
        const { app } = yield* start(
          App.make(
            App.define({
              plugins: [Rules, Sound.plugin, Assets.plugin],
              systems: [Keep, ForestCues],
            })
          ).pipe(Effect.provide(files)),
          sound
        );
        yield* app.dispatch(Step, { hard: true });
        yield* app.tick(0.1);
        yield* app.frame();
        expect(made).toBe(1);
        expect(sound.played.at(-1)!.clip).toBe(clips[0]);
        // Between two frames the creak became another creak: the lines that
        // held the old one are not the ones that play.
        afresh = true;
        yield* app.dispatch(Step, { hard: true });
        yield* app.tick(0.1);
        yield* app.frame();
        expect(made).toBe(2);
        expect(clips.length).toBe(4);
        expect(sound.played.at(-1)!.clip).toBe(clips[2]);
        expect(sound.played.length).toBe(2);
      })
  );

  it.effect(
    "need the app's assets, which their type says, and lines that are there do not",
    () =>
      Effect.gen(function* () {
        const { Forest } = makeForest();
        const Plain = Sound.cues("mu/Plain", Sound.on(Stepped, T.tap));
        const From = Sound.cues("mu/From", Forest, ({ creak }) => [
          Sound.on(Stepped, creak),
        ]);
        Sound.cues("mu/Wrong", Forest, ({ creak }) => [
          // @ts-expect-error the forest has no growl
          Sound.on(Stepped, creak.growl),
        ]);
        // @ts-expect-error the store of assets is one thing more to need
        const also: typeof Plain = From;
        expect(also.name).toBe("mu/From");
        // An app with cues that are there needs no Assets.plugin.
        const sound = Sound.makeRecorder();
        const { app } = yield* start(
          App.make(
            App.define({ plugins: [Rules, Sound.plugin], systems: [Plain] })
          ),
          sound
        );
        yield* app.dispatch(Step, { hard: true });
        yield* app.tick(0.1);
        yield* app.frame();
        expect(sound.played).toEqual([{ cue: "tap", volume: 1, rate: 1 }]);
      })
  );
});

describe("a level's music", () => {
  it.effect(
    "is a clip of its bundle, played while the bundle is loaded, and anew when it is loaded again",
    () =>
      Effect.gen(function* () {
        const sound = Sound.makeRecorder();
        const { Forest, Keep, clips } = makeForest();
        const Ambience = Sound.music("mu/Ambience", function* () {
          const forest = yield* Forest;
          return forest._tag === "Ready"
            ? { track: forest.assets.wind, volume: 0.4 }
            : undefined;
        });
        const { app } = yield* start(
          App.make(
            App.define({
              plugins: [Rules, Sound.plugin, Assets.plugin],
              systems: [Ambience, Keep],
            })
          ).pipe(Effect.provide(files)),
          sound
        );
        const go = Effect.fnUntraced(function* (
          to: "menu" | "forest" | "cave"
        ) {
          yield* app.dispatch(Go, { to });
          yield* app.tick(0.1);
          yield* app.frame();
        });
        yield* app.frame();
        expect(sound.scored).toEqual([]);
        yield* go("forest");
        yield* app.frame();
        expect(sound.scored).toEqual([
          {
            channel: "music",
            track: "/wind.ogg",
            volume: 0.4,
            fade: 0.5,
            clip: clips[1],
          },
        ]);
        expect(Object.fromEntries(sound.playing)).toEqual({
          music: "/wind.ogg",
        });
        yield* go("menu");
        expect(sound.scored.at(-1)).toEqual({
          channel: "music",
          track: undefined,
          volume: 0,
          fade: 0.5,
        });
        // The forest again is other wind, though of the same file: it starts.
        yield* go("forest");
        expect(sound.scored.length).toBe(3);
        expect(sound.scored.at(-1)!.clip).toBe(clips[3]);
        expect(clips[3]).not.toBe(clips[1]);
      })
  );

  it.effect("is a clip as it is, where nothing more is to be said of it", () =>
    Effect.gen(function* () {
      const sound = Sound.makeRecorder();
      const hum = Sound.clip("hum");
      const Hum = Sound.music("mu/Hum", function* () {
        return (yield* Level).value === "menu" ? hum : undefined;
      });
      const { app, step } = yield* play(
        App.define({ plugins, systems: [Hum] }),
        sound
      );
      yield* app.frame();
      expect(sound.scored).toEqual([
        { channel: "music", track: "hum", volume: 1, fade: 0.5, clip: hum },
      ]);
      expect(sound.scored[0]!.clip).toBe(hum);
      yield* step(Go, { to: "cave" });
      expect(sound.playing.size).toBe(0);
    })
  );
});

describe("Sound.makeRecorder", () => {
  it("notes what each channel was told, oldest first, and what each is playing now", () => {
    const sound = Sound.makeRecorder();
    const wind = Sound.clip("wind", { samples: 3 });
    sound.music("a", T.theme, { volume: 1, fade: 0.5, once: false });
    sound.music("b", wind, { volume: 0.2, fade: 0, once: false });
    expect(Object.fromEntries(sound.playing)).toEqual({
      a: "theme",
      b: "wind",
    });
    sound.music("a", undefined, { volume: 0, fade: 2, once: false });
    sound.music("c", T.fanfare, { volume: 1, fade: 0, once: true });
    sound.music("c", wind, { volume: 1, fade: 0, once: true });
    sound.music("c", T.fanfare, { volume: 1, fade: 0, once: false });
    sound.music("c", undefined, { volume: 0, fade: 0, once: true });
    expect(sound.scored).toEqual([
      { channel: "a", track: "theme", volume: 1, fade: 0.5 },
      { channel: "b", track: "wind", volume: 0.2, fade: 0, clip: wind },
      { channel: "a", track: undefined, volume: 0, fade: 2 },
      { channel: "c", track: "fanfare", volume: 1, fade: 0, once: true },
      {
        channel: "c",
        track: "wind",
        volume: 1,
        fade: 0,
        clip: wind,
        once: true,
      },
      { channel: "c", track: "fanfare", volume: 1, fade: 0 },
      // Silence is not once or over and over.
      { channel: "c", track: undefined, volume: 0, fade: 0 },
    ]);
    expect(sound.scored[1]!.clip).toBe(wind);
    expect(wind.data).toEqual({ samples: 3 });
    expect(Object.fromEntries(sound.playing)).toEqual({ b: "wind" });
    // Its cues are apart from its music, and each recorder is its own.
    expect(sound.played).toEqual([]);
    expect(Sound.makeRecorder().scored).toEqual([]);
  });
});
