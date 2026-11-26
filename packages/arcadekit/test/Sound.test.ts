import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";

import {
  Action,
  App,
  Commands,
  Component,
  Driver,
  Event,
  Field,
  Plugin,
  Query,
  Replay,
  Save,
  Singleton,
  Sound,
  State,
  System,
  Test,
  Time,
  World,
} from "../src/index.ts";
import * as Build from "../src/internal/build.ts";
import { thrown } from "./checks.ts";
import { steered } from "./peers.ts";
import * as Menu from "./volumeMenu.ts";

// --- a game that makes noise -------------------------------------------------------
// Balls fall and bounce off the floor. The simulation says so with an
// event, and knows nothing of sound.
const Ball = Component.define("sd/Ball", { y: Field.f32, speed: Field.f32 });
const Balls = Query.all(Ball).pipe(Query.writes(Ball));
const Bounces = Singleton.define(
  "sd/Bounces",
  { count: Field.i32 },
  { count: 0 }
);
const Phase = State.define("sd/Phase", ["playing", "muted"]);

const Bounced = Event.define(
  "sd/Bounced",
  Schema.Struct({ speed: Schema.Finite })
);
const Dropped = Event.define("sd/Dropped", Schema.Struct({}));
class TooHigh extends Schema.TaggedError<TooHigh>()("TooHigh", {}) {}
const Drop = Action.define(
  "sd/Drop",
  Schema.Struct({ height: Schema.Finite }),
  { error: TooHigh }
);
const Mute = Action.define("sd/Mute", Schema.Struct({ on: Schema.Boolean }));
const Throw = Action.define(
  "sd/Throw",
  Schema.Struct({ speed: Schema.Finite })
);

const Fall = System.tick("sd/Fall", function* () {
  const { delta } = yield* Time;
  const bounced = yield* Bounced.emits;
  const bounces = yield* Bounces.writes;
  let count = 0;
  (yield* Balls).each((ball) => {
    ball.speed += 10 * delta;
    ball.y -= ball.speed * delta;
    if (ball.y <= 0) {
      bounced.emit({ speed: ball.speed });
      ball.y = 0;
      ball.speed = -ball.speed;
      count++;
    }
  });
  if (count > 0) {
    bounces.count += count;
  }
});

/** The game's sounds, by the names a recorder records them by. */
const Sfx = Sound.sheet("sd/Sfx", {
  whoosh: "/whoosh.wav",
  thud: "/thud.wav",
  bang: "/bang.wav",
  click: "/click.wav",
  ping: "/ping.wav",
  anything: "/anything.wav",
  a: "/a.wav",
  b: "/b.wav",
});

/** How often a line was asked what an event sounds like. */
let asked = 0;
const Cues = Sound.cues("sd/Cues", Sfx, ({ thud, whoosh }) => [
  Sound.on(Dropped, whoosh),
  Sound.on(Bounced, ({ speed }) => {
    asked++;
    // A slow one makes no sound at all.
    return speed < 2
      ? undefined
      : {
          cue: thud,
          volume: Math.min(1, speed / 10),
          rate: speed > 8 ? 2 : 1,
        };
  }),
]);

const Rules = Plugin.make("sd/Rules", {
  systems: [Fall],
  handlers: [
    Action.handler(Drop, function* ({ height }) {
      (yield* Dropped.emits).emit({});
      if (height > 100) {
        return yield* TooHigh.make({});
      }
      (yield* Commands.spawns(Ball)).spawn(Ball.of({ y: height, speed: 0 }));
    }),
    Action.handler(Mute, function* ({ on }) {
      (yield* Phase.sets).set(on ? "muted" : "playing");
    }),
    Action.handler(Throw, function* ({ speed }) {
      (yield* Commands.spawns(Ball)).spawn(Ball.of({ y: 0.001, speed }));
    }),
  ],
});
const Game = Plugin.make("sd/Game", {
  plugins: [Rules, Sound.plugin],
  systems: [Cues],
});

const Noisy = App.define({ plugins: [Game] });

const play = Effect.fnUntraced(function* (
  output: Sound.Speaker | undefined,
  seed = 1
) {
  asked = 0;
  return yield* App.make(Noisy, { seed, hashEvery: 1 }).pipe(
    Effect.provide(
      output === undefined ? Sound.layerNowhere : Sound.layer(output)
    )
  );
});

/** A ball that hits the floor on the next tick, at `speed`. */
const about = Effect.fnUntraced(function* (
  app: Effect.Success<ReturnType<typeof play>>,
  speed: number
) {
  yield* app.dispatch(Throw, { speed });
});

describe("Sound.cues", () => {
  it.effect(
    "plays a cue once when a rewind runs its tick again, and what the tick now does",
    () =>
      Effect.gen(function* () {
        const sound = Sound.makeRecorder();
        const built = yield* Build.build(Noisy, {
          seed: 1,
          hashEvery: 1,
        }).pipe(Effect.provide(Sound.layer(sound)));
        const session = steered(built);
        const { app } = session;
        yield* session.tick(0.1);
        yield* app.frame();
        const moment = yield* session.capture();
        yield* app.enqueue(Drop, { height: 5 });
        yield* session.tick(0.1);
        yield* app.frame();
        expect(sound.played.map((one) => one.cue)).toEqual(["whoosh"]);
        // A session goes back, and runs the tick again with the same drop: it
        // was heard already, so it isn't played twice.
        yield* session.rewind(moment);
        yield* app.enqueue(Drop, { height: 5 });
        yield* session.tick(0.1);
        yield* app.frame();
        expect(sound.played.map((one) => one.cue)).toEqual(["whoosh"]);
        // Gone back again, the tick runs without it: nothing to play. Then a drop
        // of its own, past where the game had got to, is heard.
        yield* session.rewind(moment);
        yield* session.tick(0.1);
        yield* app.frame();
        yield* app.enqueue(Drop, { height: 5 });
        yield* session.tick(0.1);
        yield* app.frame();
        expect(sound.played.map((one) => one.cue)).toEqual([
          "whoosh",
          "whoosh",
        ]);
      })
  );

  it.effect(
    "plays what each event sounds like, once, in the frame after it happened",
    () =>
      Effect.gen(function* () {
        const sound = Sound.makeRecorder();
        const app = yield* play(sound);
        yield* app.dispatch(Drop, { height: 5 });
        // Nothing is played until a frame is drawn: not by the action, not by a tick.
        expect(sound.played).toEqual([]);
        yield* app.tick(0.1);
        expect(sound.played).toEqual([]);
        yield* app.frame();
        expect(sound.played).toEqual([{ cue: "whoosh", volume: 1, rate: 1 }]);
        // Heard once: the next frames have nothing new to play.
        yield* app.frame(0.5);
        yield* app.tick(0.1);
        yield* app.frame();
        expect(sound.played.length).toBe(1);

        // A payload decides the cue, how loud, and how fast.
        yield* about(app, 5);
        yield* app.tick(0.1);
        yield* app.frame();
        expect(sound.played.at(-1)).toEqual({
          cue: "thud",
          volume: 0.6,
          rate: 1,
        });
        yield* about(app, 20);
        yield* app.tick(0.1);
        yield* app.frame();
        expect(sound.played.at(-1)).toEqual({
          cue: "thud",
          volume: 1,
          rate: 2,
        });
        // Or that there is nothing to hear.
        const before = sound.played.length;
        const lines = asked;
        yield* about(app, 0.5);
        yield* app.tick(0.1);
        yield* app.frame();
        expect(asked).toBe(lines + 1);
        expect(sound.played.length).toBe(before);
      })
  );

  it.effect(
    "hears every event of every tick since the last frame, and none twice",
    () =>
      Effect.gen(function* () {
        const sound = Sound.makeRecorder();
        const app = yield* play(sound);
        yield* app.frame();
        // Three ticks and then one frame: a drop in the first, a bounce in the last.
        yield* app.enqueue(Drop, { height: 0.001 });
        yield* app.tick(0.1);
        yield* app.tick(0.1);
        yield* about(app, 6);
        yield* app.tick(0.1);
        yield* app.frame();
        expect(sound.played.map((one) => one.cue)).toEqual(["whoosh", "thud"]);
        // A frame with no tick before it, and ticks with nothing to say.
        yield* app.frame(0.4);
        yield* app.tick(0.001);
        yield* app.frame();
        expect(sound.played.length).toBe(2);
      })
  );

  it.effect(
    "plays a cue once for all the events of a frame that ask for it, as the loudest asked, in the order first asked",
    () =>
      Effect.gen(function* () {
        const sound = Sound.makeRecorder();
        const app = yield* play(sound);
        for (const speed of [3, 9, 4, 0.1]) {
          yield* about(app, speed);
        }
        yield* app.enqueue(Drop, { height: 50 });
        yield* app.enqueue(Drop, { height: 60 });
        yield* app.tick(0.01);
        yield* app.frame();
        // Four bounces and two drops: two sounds. The loudest bounce was the
        // fast one, and it is played at its own rate.
        expect(asked).toBe(4);
        expect(sound.played).toEqual([
          { cue: "whoosh", volume: 1, rate: 1 },
          // The speed is a 32-bit float in the world.
          { cue: "thud", volume: Math.fround(9 + 10 * 0.01) / 10, rate: 2 },
        ]);
        // The next frame's events are another frame's: played again.
        yield* about(app, 3);
        yield* app.tick(0.01);
        yield* app.frame();
        expect(sound.played.length).toBe(3);
        expect(sound.played[2]!.cue).toBe("thud");
        expect(sound.played[2]!.rate).toBe(1);
      })
  );

  it.effect("makes no sound for what a refused action emitted", () =>
    Effect.gen(function* () {
      const sound = Sound.makeRecorder();
      const app = yield* play(sound);
      expect(
        Exit.isFailure(yield* Effect.exit(app.dispatch(Drop, { height: 500 })))
      ).toBe(true);
      yield* app.enqueue(Drop, { height: 500 });
      yield* app.tick(0.1);
      yield* app.frame();
      expect(sound.played).toEqual([]);
    })
  );

  it.effect(
    "plays nothing while its system does not run, and nothing later of what happened meanwhile",
    () =>
      Effect.gen(function* () {
        const Quiet = Sound.cues("sd/Quiet", Sfx, ({ whoosh }) => [
          Sound.on(Dropped, whoosh),
        ]).pipe(System.runIf(State.is(Phase, "playing")));
        const sound = Sound.makeRecorder();
        const app = yield* App.make(
          App.define({ plugins: [Rules, Sound.plugin], systems: [Quiet] })
        ).pipe(Effect.provide(Sound.layer(sound)));
        yield* app.dispatch(Mute, { on: true });
        yield* app.tick(0.1);
        yield* app.dispatch(Drop, { height: 1 });
        yield* app.tick(0.1);
        yield* app.frame();
        expect(sound.played).toEqual([]);
        yield* app.dispatch(Mute, { on: false });
        yield* app.tick(0.1);
        yield* app.frame();
        expect(sound.played).toEqual([]);
        yield* app.dispatch(Drop, { height: 1 });
        yield* app.tick(0.1);
        yield* app.frame();
        expect(sound.played).toEqual([{ cue: "whoosh", volume: 1, rate: 1 }]);
        expect(Quiet.name).toBe("sd/Quiet");
        expect(Quiet.stage).toBe("frame");
      })
  );

  it.effect("reads nothing and plays nothing where sound goes nowhere", () =>
    Effect.gen(function* () {
      const app = yield* play(undefined);
      yield* about(app, 5);
      yield* app.dispatch(Drop, { height: 1 });
      yield* app.tick(0.1);
      yield* app.frame();
      expect(asked).toBe(0);
      // With an output, the same frame asks.
      const heard = yield* play(Sound.makeRecorder());
      yield* about(heard, 5);
      yield* heard.tick(0.1);
      yield* heard.frame();
      expect(asked).toBe(1);
    })
  );

  it.effect("is driven by a driver's frames like anything that draws", () =>
    Effect.gen(function* () {
      const sound = Sound.makeRecorder();
      const app = yield* play(sound);
      const advance = Driver.fixedStep(app, { hz: 10 });
      yield* about(app, 5);
      yield* app.enqueue(Drop, { height: 3 });
      // A frame in which no tick is due plays nothing: nothing happened.
      yield* advance(0.01);
      expect(sound.played).toEqual([]);
      yield* advance(0.1);
      expect(sound.played.map((one) => one.cue)).toEqual(["whoosh", "thud"]);
    })
  );
});

describe("Sound.Player", () => {
  it("is never called by the simulation: a tick system or a handler cannot play", () => {
    System.tick(
      "sd/Loud",
      // @ts-expect-error sound is the frame's
      function* () {
        (yield* Sound.Player).play(Sound.clip("bang"));
      }
    );
    const Bang = Action.define("sd/Bang", Schema.Struct({}));
    Action.handler(
      Bang,
      // @ts-expect-error sound is the frame's
      function* () {
        (yield* Sound.Player).play(Sound.clip("bang"));
      }
    );
    // Nor can it take a sheet's sounds, which are only to play.
    System.tick(
      "sd/Sheeted",
      // @ts-expect-error sound is the frame's
      function* () {
        yield* Sfx;
      }
    );
    expect(Bang.name).toBe("sd/Bang");
  });

  it.effect(
    "plays for a system of the frame stage, as it is told, once the frame's systems have run",
    () =>
      Effect.gen(function* () {
        let clicks: readonly (Sound.PlayOptions | undefined)[] = [];
        const heard: number[] = [];
        const sound = Sound.makeRecorder();
        const Click = System.frame("sd/Click", function* () {
          const { click } = yield* Sfx;
          const player = yield* Sound.Player;
          for (const options of clicks) {
            player.play(click, options);
          }
          // Asked for, and not played yet: the frame is not over.
          heard.push(sound.played.length);
        });
        const app = yield* App.make(
          App.define({ plugins: [Sound.plugin], systems: [Click] })
        ).pipe(Effect.provide(Sound.layer(sound)));
        const frame = Effect.fnUntraced(function* (
          ...asked: (Sound.PlayOptions | undefined)[]
        ) {
          clicks = asked;
          sound.played.length = 0;
          yield* app.frame();
          return [...sound.played];
        });
        // As it is, and as it is told.
        expect(yield* frame(undefined)).toEqual([
          { cue: "click", volume: 1, rate: 1 },
        ]);
        expect(yield* frame({ volume: 0.25 })).toEqual([
          { cue: "click", volume: 0.25, rate: 1 },
        ]);
        expect(yield* frame({ rate: 1.5 })).toEqual([
          { cue: "click", volume: 1, rate: 1.5 },
        ]);
        // Not below nothing.
        expect(yield* frame({ volume: -3, rate: 0.5 })).toEqual([
          { cue: "click", volume: 0, rate: 0.5 },
        ]);
        expect(heard).toEqual([0, 0, 0, 0]);
        // Asked several times in one frame it is one sound, as the loudest
        // asked, and of two as loud the first.
        expect(
          yield* frame(
            { volume: 0.5, rate: 2 },
            { volume: 0.9, rate: 3 },
            { volume: 0.9 }
          )
        ).toEqual([{ cue: "click", volume: 0.9, rate: 3 }]);
        // And nothing is left of a frame for the next.
        expect(yield* frame()).toEqual([]);
        expect(app.frameOrder).toEqual([
          "arcadekit/Sound.Begin",
          "sd/Click",
          "arcadekit/Sound.Flush",
        ]);
      })
  );

  it.effect(
    "makes one sound of a cue that several systems play in one frame, whichever they are",
    () =>
      Effect.gen(function* () {
        const sound = Sound.makeRecorder();
        const Theirs = Sound.cues("sd/Theirs", Sfx, ({ thud, whoosh }) => [
          Sound.on(Bounced, { cue: thud, volume: 0.3 }),
          Sound.on(Dropped, whoosh),
        ]);
        const Mine = System.frame("sd/Mine", function* () {
          const { ping, whoosh } = yield* Sfx;
          (yield* Sound.Player).play(whoosh, { volume: 0.2, rate: 2 });
          (yield* Sound.Player).play(ping);
        });
        const app = yield* App.make(
          App.define({ plugins: [Game], systems: [Theirs, Mine] })
        ).pipe(Effect.provide(Sound.layer(sound)));
        yield* about(app, 5);
        yield* app.dispatch(Drop, { height: 50 });
        yield* app.tick(0.1);
        yield* app.frame();
        // The game's own cues ask for a whoosh and a thud, the second system
        // for both again, and the third for a whoosh: one of each, each as
        // the loudest asked, in the order they were first asked for.
        expect(sound.played.map((one) => one.cue)).toEqual([
          "whoosh",
          "thud",
          "ping",
        ]);
        expect(sound.played[0]).toEqual({ cue: "whoosh", volume: 1, rate: 1 });
        expect(sound.played[1]!.volume).toBeGreaterThan(0.3);
      })
  );

  it.effect("plays nothing that a failed frame asked for", () =>
    Effect.gen(function* () {
      const sound = Sound.makeRecorder();
      let failing = true;
      const Click = System.frame("sd/Click", function* () {
        if (failing) {
          (yield* Sound.Player).play((yield* Sfx).click);
          return yield* Effect.fail("broken");
        }
      });
      const app = yield* App.make(
        App.define({ plugins: [Sound.plugin], systems: [Click] })
      ).pipe(Effect.provide(Sound.layer(sound)));
      expect(yield* thrown(app.frame())).toThrow("broken");
      failing = false;
      yield* app.frame();
      expect(sound.played).toEqual([]);
    })
  );

  it.effect("says whether sound goes anywhere", () =>
    Effect.gen(function* () {
      const seen: boolean[] = [];
      const Ask = System.frame("sd/Ask", function* () {
        seen.push((yield* Sound.Player).audible);
        // Playing to nowhere is no mistake.
        (yield* Sound.Player).play((yield* Sfx).anything);
      });
      const Asking = App.define({ plugins: [Sound.plugin], systems: [Ask] });
      yield* (yield* App.make(Asking).pipe(
        Effect.provide(Sound.layerNowhere)
      )).frame();
      yield* (yield* App.make(Asking).pipe(
        Effect.provide(Sound.layer(Sound.makeRecorder()))
      )).frame();
      expect(seen).toEqual([false, true]);
    })
  );

  it("is what a plugin's systems need: a game with cues that leaves out Sound.plugin does not compile", () => {
    // Sound.Player is still needed: Sound.plugin provides it.
    expectTypeOf(
      App.make(App.define({ plugins: [Rules], systems: [Cues] }))
    ).not.toExtend<Effect.Effect<unknown, never>>();
    expectTypeOf(
      App.make(App.define({ plugins: [Game] })).pipe(
        Effect.provide(Sound.layerNowhere)
      )
    ).toExtend<Effect.Effect<unknown, never>>();
  });
});

describe("a game with sound", () => {
  it.effect(
    "is the same game as one with none: the same hash, log and save, tick for tick",
    () =>
      Effect.gen(function* () {
        const sound = Sound.makeRecorder();
        const heard = yield* App.make(App.define({ plugins: [Game] }), {
          seed: 9,
          hashEvery: 1,
          verifyFrames: true,
        }).pipe(Effect.provide(Sound.layer(sound)));
        // No output, and no system that plays: the rules alone.
        const deaf = yield* App.make(App.define({ plugins: [Rules] }), {
          seed: 9,
          hashEvery: 1,
        });
        for (const app of [heard, deaf]) {
          yield* app.dispatch(Drop, { height: 2 });
          yield* app.dispatch(Drop, { height: 0.5 });
        }
        const heardWorld = yield* heard.read(World);
        const deafWorld = yield* deaf.read(World);
        for (let i = 0; i < 80; i++) {
          yield* heard.tick(0.05);
          yield* heard.frame(0.5);
          yield* deaf.tick(0.05);
          expect(heardWorld.hash()).toBe(deafWorld.hash());
        }
        expect(heard.actionLog).toEqual(deaf.actionLog);
        const saves = [
          yield* Effect.exit(Save.make(heard)),
          yield* Effect.exit(Save.make(deaf)),
        ].map((save) => (Exit.isSuccess(save) ? save.value : undefined));
        expect(saves[0]).toBeDefined();
        expect(saves[0]).toEqual(saves[1]);
        // And it was heard: every bounce that was fast enough.
        expect((yield* heard.read(Bounces)).count).toBeGreaterThan(5);
        expect(
          sound.played.filter((one) => one.cue === "thud").length
        ).toBeGreaterThan(5);
        expect(sound.played.filter((one) => one.cue === "whoosh").length).toBe(
          1
        );
      })
  );

  it.effect(
    "replays in silence: a replay runs no frame, and plays nothing",
    () =>
      Effect.gen(function* () {
        const sound = Sound.makeRecorder();
        const app = yield* play(sound, 3);
        yield* app.dispatch(Drop, { height: 1 });
        for (let i = 0; i < 30; i++) {
          yield* app.tick(0.05);
          yield* app.frame();
        }
        expect(sound.played.length).toBeGreaterThan(1);
        const again = Sound.makeRecorder();
        const recording = yield* Replay.record(app);
        const replayed = yield* Replay.verify(recording, Noisy, {
          hashEvery: 1,
        }).pipe(Effect.provide(Sound.layer(again)));
        expect((yield* replayed.read(World)).hash()).toBe(
          (yield* app.read(World)).hash()
        );
        expect(again.played).toEqual([]);
      })
  );
});

describe("Sound.makeRecorder", () => {
  it.effect(
    "notes what it was asked to play, oldest first, and plays nothing",
    () =>
      Effect.gen(function* () {
        const { a, b } = yield* Effect.provide(Sfx, Sound.layerNowhere);
        const sound = Sound.makeRecorder();
        sound.play(a, { volume: 1, rate: 1 });
        sound.play(b, { volume: 0.5, rate: 2 });
        expect(sound.played).toEqual([
          { cue: "a", volume: 1, rate: 1 },
          { cue: "b", volume: 0.5, rate: 2 },
        ]);
        // Each its own.
        expect(Sound.makeRecorder().played).toEqual([]);
      })
  );
});

describe("a cue sheet", () => {
  it.effect(
    "names each sound as a clip, and a cue that is not in it doesn't compile",
    () =>
      Effect.gen(function* () {
        const Named = Sound.sheet("sd/Named", {
          coin: "/coin.wav",
          thud: "/thud.wav",
        });
        const sounds = yield* Effect.provide(Named, Sound.layerNowhere);
        expect(Named.name).toBe("sd/Named");
        expect(Object.keys(sounds)).toEqual(["coin", "thud"]);
        expect(sounds.coin).toBeInstanceOf(Sound.Clip);
        expect(sounds.coin.name).toBe("coin");
        const lines = [
          Sound.on(Dropped, sounds.coin),
          // @ts-expect-error A sound the sheet doesn't have.
          Sound.on(Dropped, sounds.coni),
          // @ts-expect-error A name is no sound: a sheet's sound is.
          Sound.on(Dropped, "coin"),
        ];
        expect(lines.length).toBe(3);
        // @ts-expect-error Its sounds are a yield's: a game has none outside one.
        expect(Named.coin).toBeUndefined();
      })
  );

  it("is played only where it is had: a game that plays from it requires it of what runs the game", () => {
    const Tunes = Sound.sheet("sd/Tunes", { theme: "/theme.ogg" });
    const Theme = Sound.music("sd/Theme", function* () {
      return (yield* Tunes).theme;
    });
    const Tuned = App.define({ plugins: [Game], systems: [Theme] });
    // Of every sheet the game plays from, cues and music alike.
    expectTypeOf(App.make(Tuned)).toExtend<
      Effect.Effect<
        unknown,
        never,
        Sound.Plays<"sd/Sfx"> | Sound.Plays<"sd/Tunes">
      >
    >();
    expectTypeOf(App.make(Tuned)).not.toExtend<
      Effect.Effect<unknown, never, Sound.Plays<"sd/Sfx">>
    >();
    // A speaker of one's own has them all, and so has nowhere.
    expectTypeOf(
      App.make(Tuned).pipe(Effect.provide(Sound.layer(Sound.makeRecorder())))
    ).toExtend<Effect.Effect<unknown, never>>();
    expectTypeOf(
      App.make(Tuned).pipe(Effect.provide(Sound.layerNowhere))
    ).toExtend<Effect.Effect<unknown, never>>();
    expectTypeOf(Test.make(Tuned)).toExtend<Effect.Effect<unknown, never>>();
  });

  it.effect(
    "is recorded by its names, and a clip of a bundle with itself",
    () =>
      Effect.gen(function* () {
        const Recorded = Sound.sheet("sd/Recorded", { coin: "/coin.wav" });
        const { coin } = yield* Effect.provide(Recorded, Sound.layerNowhere);
        const loaded = Sound.clip("chirp", { samples: 2 });
        const sound = Sound.makeRecorder();
        sound.play(coin, { volume: 1, rate: 1 });
        sound.play(loaded, { volume: 1, rate: 1 });
        sound.music("music", coin, { volume: 1, fade: 0, once: false });
        expect(sound.played).toEqual([
          { cue: "coin", volume: 1, rate: 1 },
          { cue: "chirp", volume: 1, rate: 1, clip: loaded },
        ]);
        expect(sound.scored).toEqual([
          { channel: "music", track: "coin", volume: 1, fade: 0 },
        ]);
      })
  );
});

describe("a bus", () => {
  it.effect(
    "is set by a frame system from the game's settings: the music at half and the effects silent while both play, and back",
    () =>
      Effect.gen(function* () {
        const game = yield* Test.make(Menu.Game);
        yield* game.app.dispatch(Menu.Catch, {});
        yield* game.step();
        expect(game.sound.played).toEqual([
          { cue: "coin", volume: 1, rate: 1 },
        ]);
        expect(game.sound.scored).toEqual([
          { channel: "music", track: "theme", volume: 1, fade: 0.5 },
        ]);

        // The menu: the music at half, the effects off.
        yield* game.app.dispatch(Menu.Choose, { music: 0.5, effects: false });
        yield* game.app.dispatch(Menu.Catch, {});
        yield* game.step();
        // The coin is played silent, and the theme plays on at half, at once.
        expect(game.sound.played.at(-1)).toEqual({
          cue: "coin",
          volume: 0,
          rate: 1,
        });
        expect(game.sound.scored.at(-1)).toEqual({
          channel: "music",
          track: "theme",
          volume: 0.5,
          fade: 0,
        });
        // Set again each frame, it is no change.
        yield* game.step();
        expect(game.sound.scored.length).toBe(2);

        yield* game.app.dispatch(Menu.Choose, { music: 1, effects: true });
        yield* game.app.dispatch(Menu.Catch, {});
        yield* game.step();
        expect(game.sound.played.at(-1)).toEqual({
          cue: "coin",
          volume: 1,
          rate: 1,
        });
        expect(game.sound.scored.at(-1)).toEqual({
          channel: "music",
          track: "theme",
          volume: 1,
          fade: 0,
        });
      })
  );

  it.effect(
    "scales only what plays on it: a cue or a channel that names another bus is as loud as it asks",
    () =>
      Effect.gen(function* () {
        const Buzz = Sound.sheet("sd/Buses", {
          click: "/click.wav",
          hum: "/hum.wav",
        });
        const UiBus = Sound.bus("ui");
        const sound = Sound.makeRecorder();
        const Loud = System.frame("sd/Loud", function* () {
          const { click, hum } = yield* Buzz;
          const player = yield* Sound.Player;
          player.volume(Sound.EffectsBus, 0.25);
          player.volume(Sound.MusicBus, 0);
          player.play(click, { volume: 0.8 });
          player.play(hum, { bus: UiBus });
          player.music("ui", hum, { bus: UiBus, fade: 0 });
        });
        const app = yield* App.make(
          App.define({ plugins: [Sound.plugin], systems: [Loud] })
        ).pipe(Effect.provide(Sound.layer(sound)));
        yield* app.frame();
        expect(sound.played).toEqual([
          { cue: "click", volume: 0.2, rate: 1 },
          { cue: "hum", volume: 1, rate: 1 },
        ]);
        expect(sound.scored).toEqual([
          { channel: "ui", track: "hum", volume: 1, fade: 0 },
        ]);
      })
  );

  it("is a bus that was declared, or doesn't compile", () => {
    const UiBus = Sound.bus("ui");
    const Buses = { music: Sound.MusicBus, ui: UiBus };
    const Declared = Sound.sheet("sd/Declared", { click: "/click.wav" });
    const Menu = System.frame("sd/Menu", function* () {
      const { click } = yield* Declared;
      const player = yield* Sound.Player;
      player.volume(UiBus, 0.5);
      // @ts-expect-error A bus is a declared value, never a name.
      player.volume("musci", 0.5);
      // @ts-expect-error No bus of that name was declared.
      player.volume(Buses.musci, 0.5);
      // @ts-expect-error The bus of a cue is a declared one too.
      player.play(click, { bus: "ui" });
    });
    const Cues = Sound.cues("sd/Declared", Declared, ({ click }) => [
      // @ts-expect-error The bus of a cue is a declared one too.
      Sound.on(Dropped, { cue: click, bus: "effects" }),
    ]);
    expect([Menu.stage, Cues.stage]).toEqual(["frame", "frame"]);
    expect([Sound.MusicBus.name, Sound.EffectsBus.name, UiBus.name]).toEqual([
      "music",
      "effects",
      "ui",
    ]);
  });

  it.effect("refuses a volume below silence or that is no number", () =>
    Effect.gen(function* () {
      for (const volume of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const Wrong = System.frame("sd/Wrong", function* () {
          (yield* Sound.Player).volume(Sound.MusicBus, volume);
        });
        const app = yield* App.make(
          App.define({ plugins: [Sound.plugin], systems: [Wrong] })
        ).pipe(Effect.provide(Sound.layer(Sound.makeRecorder())));
        expect(yield* thrown(app.frame())).toThrow(
          `The bus "music" was given the volume ${volume}.`
        );
      }
    })
  );
});
