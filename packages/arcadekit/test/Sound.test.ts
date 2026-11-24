import { Data, Effect, Exit, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import * as Build from "../src/app/internal/build";
import {
  Action,
  App,
  Commands,
  Component,
  Driver,
  Event,
  Field,
  Journal,
  Plugin,
  Query,
  Singleton,
  Sound,
  State,
  System,
  Time,
  World,
} from "../src/index";
import { steered } from "./peers";

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
const Drop = Action.define("sd/Drop", Schema.Struct({ height: Schema.Finite }));
const Mute = Action.define("sd/Mute", Schema.Struct({ on: Schema.Boolean }));
const Throw = Action.define(
  "sd/Throw",
  Schema.Struct({ speed: Schema.Finite })
);

class TooHigh extends Data.TaggedError("TooHigh")<{}> {}

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

/** How often a line was asked what an event sounds like. */
let asked = 0;
const Cues = Sound.cues(
  "sd/Cues",
  Sound.on(Dropped, "whoosh"),
  Sound.on(Bounced, ({ speed }) => {
    asked++;
    // A slow one makes no sound at all.
    return speed < 2
      ? undefined
      : {
          cue: "thud",
          volume: Math.min(1, speed / 10),
          rate: speed > 8 ? 2 : 1,
        };
  })
);

const Rules = Plugin.make("sd/Rules", {
  systems: [Fall],
  handlers: [
    Action.handler(Drop, function* ({ height }) {
      (yield* Dropped.emits).emit({});
      if (height > 100) {
        return yield* new TooHigh();
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

const play = (output: Sound.Speaker | undefined, seed = 1) => {
  asked = 0;
  const made = App.make(Noisy, { seed, checkpointEvery: 1 });
  return Effect.runSync(
    output === undefined ? made : made.pipe(Effect.provide(Sound.layer(output)))
  );
};

/** A ball that hits the floor on the next tick, at `speed`. */
const about = (app: ReturnType<typeof play>, speed: number): void => {
  app.dispatch(Throw, { speed });
};

describe("Sound.cues", () => {
  it("plays a cue once when a rewind runs its tick again, and what the tick now does", () => {
    const sound = Sound.makeRecorder();
    const built = Effect.runSync(
      Build.build(Noisy, { seed: 1, checkpointEvery: 1 }).pipe(
        Effect.provide(Sound.layer(sound))
      )
    );
    const session = steered(built);
    const { app } = session;
    session.tick(0.1);
    app.frame();
    const moment = session.capture();
    app.enqueue(Drop, { height: 5 });
    session.tick(0.1);
    app.frame();
    expect(sound.played.map((one) => one.cue)).toEqual(["whoosh"]);
    // A session goes back, and runs the tick again with the same drop: it
    // was heard already, so it isn't played twice.
    session.rewind(moment);
    app.enqueue(Drop, { height: 5 });
    session.tick(0.1);
    app.frame();
    expect(sound.played.map((one) => one.cue)).toEqual(["whoosh"]);
    // Gone back again, the tick runs without it: nothing to play. Then a drop
    // of its own, past where the game had got to, is heard.
    session.rewind(moment);
    session.tick(0.1);
    app.frame();
    app.enqueue(Drop, { height: 5 });
    session.tick(0.1);
    app.frame();
    expect(sound.played.map((one) => one.cue)).toEqual(["whoosh", "whoosh"]);
  });

  it("plays what each event sounds like, once, in the frame after it happened", () => {
    const sound = Sound.makeRecorder();
    const app = play(sound);
    app.dispatch(Drop, { height: 5 });
    // Nothing is played until a frame is drawn: not by the action, not by a tick.
    expect(sound.played).toEqual([]);
    app.tick(0.1);
    expect(sound.played).toEqual([]);
    app.frame();
    expect(sound.played).toEqual([{ cue: "whoosh", volume: 1, rate: 1 }]);
    // Heard once: the next frames have nothing new to play.
    app.frame(0.5);
    app.tick(0.1);
    app.frame();
    expect(sound.played.length).toBe(1);

    // A payload decides the cue, how loud, and how fast.
    about(app, 5);
    app.tick(0.1);
    app.frame();
    expect(sound.played.at(-1)).toEqual({ cue: "thud", volume: 0.6, rate: 1 });
    about(app, 20);
    app.tick(0.1);
    app.frame();
    expect(sound.played.at(-1)).toEqual({ cue: "thud", volume: 1, rate: 2 });
    // Or that there is nothing to hear.
    const before = sound.played.length;
    const lines = asked;
    about(app, 0.5);
    app.tick(0.1);
    app.frame();
    expect(asked).toBe(lines + 1);
    expect(sound.played.length).toBe(before);
  });

  it("hears every event of every tick since the last frame, and none twice", () => {
    const sound = Sound.makeRecorder();
    const app = play(sound);
    app.frame();
    // Three ticks and then one frame: a drop in the first, a bounce in the last.
    app.enqueue(Drop, { height: 0.001 });
    app.tick(0.1);
    app.tick(0.1);
    about(app, 6);
    app.tick(0.1);
    app.frame();
    expect(sound.played.map((one) => one.cue)).toEqual(["whoosh", "thud"]);
    // A frame with no tick before it, and ticks with nothing to say.
    app.frame(0.4);
    app.tick(0.001);
    app.frame();
    expect(sound.played.length).toBe(2);
  });

  it("plays a cue once for all the events of a frame that ask for it, as the loudest asked, in the order first asked", () => {
    const sound = Sound.makeRecorder();
    const app = play(sound);
    for (const speed of [3, 9, 4, 0.1]) {
      about(app, speed);
    }
    app.enqueue(Drop, { height: 50 });
    app.enqueue(Drop, { height: 60 });
    app.tick(0.01);
    app.frame();
    // Four bounces and two drops: two sounds. The loudest bounce was the
    // fast one, and it is played at its own rate.
    expect(asked).toBe(4);
    expect(sound.played).toEqual([
      { cue: "whoosh", volume: 1, rate: 1 },
      // The speed is a 32-bit float in the world.
      { cue: "thud", volume: Math.fround(9 + 10 * 0.01) / 10, rate: 2 },
    ]);
    // The next frame's events are another frame's: played again.
    about(app, 3);
    app.tick(0.01);
    app.frame();
    expect(sound.played.length).toBe(3);
    expect(sound.played[2]!.cue).toBe("thud");
    expect(sound.played[2]!.rate).toBe(1);
  });

  it("makes no sound for what a refused action emitted", () => {
    const sound = Sound.makeRecorder();
    const app = play(sound);
    expect(Exit.isFailure(app.dispatch(Drop, { height: 500 }))).toBe(true);
    app.enqueue(Drop, { height: 500 });
    app.tick(0.1);
    app.frame();
    expect(sound.played).toEqual([]);
  });

  it("plays nothing while its system does not run, and nothing later of what happened meanwhile", () => {
    const Quiet = Sound.cues("sd/Quiet", Sound.on(Dropped, "whoosh")).pipe(
      System.runIf(State.is(Phase, "playing"))
    );
    const sound = Sound.makeRecorder();
    const app = Effect.runSync(
      App.make(
        App.define({ plugins: [Rules, Sound.plugin], systems: [Quiet] })
      ).pipe(Effect.provide(Sound.layer(sound)))
    );
    app.dispatch(Mute, { on: true });
    app.tick(0.1);
    app.dispatch(Drop, { height: 1 });
    app.tick(0.1);
    app.frame();
    expect(sound.played).toEqual([]);
    app.dispatch(Mute, { on: false });
    app.tick(0.1);
    app.frame();
    expect(sound.played).toEqual([]);
    app.dispatch(Drop, { height: 1 });
    app.tick(0.1);
    app.frame();
    expect(sound.played).toEqual([{ cue: "whoosh", volume: 1, rate: 1 }]);
    expect(Quiet.name).toBe("sd/Quiet");
    expect(Quiet.stage).toBe("frame");
  });

  it("reads nothing and plays nothing where sound goes nowhere", () => {
    const app = play(undefined);
    about(app, 5);
    app.dispatch(Drop, { height: 1 });
    app.tick(0.1);
    app.frame();
    expect(asked).toBe(0);
    // With an output, the same frame asks.
    const heard = play(Sound.makeRecorder());
    about(heard, 5);
    heard.tick(0.1);
    heard.frame();
    expect(asked).toBe(1);
  });

  it("is driven by a driver's frames like anything that draws", () => {
    const sound = Sound.makeRecorder();
    const app = play(sound);
    const advance = Driver.fixedStep(app, { hz: 10 });
    about(app, 5);
    app.enqueue(Drop, { height: 3 });
    // A frame in which no tick is due plays nothing: nothing happened.
    advance(0.01);
    expect(sound.played).toEqual([]);
    advance(0.1);
    expect(sound.played.map((one) => one.cue)).toEqual(["whoosh", "thud"]);
  });
});

describe("Sound.Player", () => {
  it("is never called by the simulation: a tick system or a handler cannot play", () => {
    System.tick(
      "sd/Loud",
      // @ts-expect-error sound is the frame's
      function* () {
        (yield* Sound.Player).play("bang");
      }
    );
    const Bang = Action.define("sd/Bang", Schema.Struct({}));
    Action.handler(
      Bang,
      // @ts-expect-error sound is the frame's
      function* () {
        (yield* Sound.Player).play("bang");
      }
    );
    expect(Bang.name).toBe("sd/Bang");
  });

  it("plays for a system of the frame stage, as it is told, once the frame's systems have run", () => {
    let clicks: readonly (Sound.Options | undefined)[] = [];
    const heard: number[] = [];
    const sound = Sound.makeRecorder();
    const Click = System.frame("sd/Click", function* () {
      const player = yield* Sound.Player;
      for (const options of clicks) {
        player.play("click", options);
      }
      // Asked for, and not played yet: the frame is not over.
      heard.push(sound.played.length);
    });
    const app = Effect.runSync(
      App.make(App.define({ plugins: [Sound.plugin], systems: [Click] })).pipe(
        Effect.provide(Sound.layer(sound))
      )
    );
    const frame = (...asked: (Sound.Options | undefined)[]): Sound.Played[] => {
      clicks = asked;
      sound.played.length = 0;
      app.frame();
      return [...sound.played];
    };
    // As it is, and as it is told.
    expect(frame(undefined)).toEqual([{ cue: "click", volume: 1, rate: 1 }]);
    expect(frame({ volume: 0.25 })).toEqual([
      { cue: "click", volume: 0.25, rate: 1 },
    ]);
    expect(frame({ rate: 1.5 })).toEqual([
      { cue: "click", volume: 1, rate: 1.5 },
    ]);
    // Not below nothing.
    expect(frame({ volume: -3, rate: 0.5 })).toEqual([
      { cue: "click", volume: 0, rate: 0.5 },
    ]);
    expect(heard).toEqual([0, 0, 0, 0]);
    // Asked several times in one frame it is one sound, as the loudest
    // asked, and of two as loud the first.
    expect(
      frame({ volume: 0.5, rate: 2 }, { volume: 0.9, rate: 3 }, { volume: 0.9 })
    ).toEqual([{ cue: "click", volume: 0.9, rate: 3 }]);
    // And nothing is left of a frame for the next.
    expect(frame()).toEqual([]);
    expect(app.frameOrder).toEqual([
      "arcadekit/Sound.Begin",
      "sd/Click",
      "arcadekit/Sound.Flush",
    ]);
  });

  it("makes one sound of a cue that several systems play in one frame, whichever they are", () => {
    const sound = Sound.makeRecorder();
    const Theirs = Sound.cues(
      "sd/Theirs",
      Sound.on(Bounced, { cue: "thud", volume: 0.3 }),
      Sound.on(Dropped, "whoosh")
    );
    const Mine = System.frame("sd/Mine", function* () {
      (yield* Sound.Player).play("whoosh", { volume: 0.2, rate: 2 });
      (yield* Sound.Player).play("ping");
    });
    const app = Effect.runSync(
      App.make(App.define({ plugins: [Game], systems: [Theirs, Mine] })).pipe(
        Effect.provide(Sound.layer(sound))
      )
    );
    about(app, 5);
    app.dispatch(Drop, { height: 50 });
    app.tick(0.1);
    app.frame();
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
  });

  it("plays nothing that a failed frame asked for", () => {
    const sound = Sound.makeRecorder();
    let failing = true;
    const Click = System.frame("sd/Click", function* () {
      if (failing) {
        (yield* Sound.Player).play("click");
        return yield* Effect.fail("broken");
      }
    });
    const app = Effect.runSync(
      App.make(App.define({ plugins: [Sound.plugin], systems: [Click] })).pipe(
        Effect.provide(Sound.layer(sound))
      )
    );
    expect(() => app.frame()).toThrow("broken");
    failing = false;
    app.frame();
    expect(sound.played).toEqual([]);
  });

  it("says whether sound goes anywhere", () => {
    const seen: boolean[] = [];
    const Ask = System.frame("sd/Ask", function* () {
      seen.push((yield* Sound.Player).audible);
      // Playing to nowhere is no mistake.
      (yield* Sound.Player).play("anything");
    });
    const Asking = App.define({ plugins: [Sound.plugin], systems: [Ask] });
    Effect.runSync(App.make(Asking)).frame();
    Effect.runSync(
      App.make(Asking).pipe(Effect.provide(Sound.layer(Sound.makeRecorder())))
    ).frame();
    expect(seen).toEqual([false, true]);
  });

  it("is what a plugin's systems need: a game with cues that leaves out Sound.plugin does not compile", () => {
    // Sound.Player is still needed: Sound.plugin provides it.
    expectTypeOf(
      App.make(App.define({ plugins: [Rules], systems: [Cues] }))
    ).not.toExtend<Effect.Effect<unknown, never>>();
    expectTypeOf(App.make(App.define({ plugins: [Game] }))).toExtend<
      Effect.Effect<unknown, never>
    >();
  });
});

describe("a game with sound", () => {
  it("is the same game as one with none: the same hash, log and save, tick for tick", () => {
    const sound = Sound.makeRecorder();
    const heard = Effect.runSync(
      App.make(App.define({ plugins: [Game] }), {
        seed: 9,
        checkpointEvery: 1,
        verifyFrames: true,
      }).pipe(Effect.provide(Sound.layer(sound)))
    );
    // No output, and no system that plays: the rules alone.
    const deaf = Effect.runSync(
      App.make(App.define({ plugins: [Rules] }), {
        seed: 9,
        checkpointEvery: 1,
      })
    );
    for (const app of [heard, deaf]) {
      app.dispatch(Drop, { height: 2 });
      app.dispatch(Drop, { height: 0.5 });
    }
    const heardWorld = Effect.runSync(heard.read(World));
    const deafWorld = Effect.runSync(deaf.read(World));
    for (let i = 0; i < 80; i++) {
      heard.tick(0.05);
      heard.frame(0.5);
      deaf.tick(0.05);
      expect(heardWorld.hash()).toBe(deafWorld.hash());
    }
    expect(heard.actionLog).toEqual(deaf.actionLog);
    const saves = [heard.save(), deaf.save()].map((save) =>
      Exit.isSuccess(save) ? save.value : undefined
    );
    expect(saves[0]).toBeDefined();
    expect(saves[0]).toEqual(saves[1]);
    // And it was heard: every bounce that was fast enough.
    expect(Effect.runSync(heard.read(Bounces)).count).toBeGreaterThan(5);
    expect(
      sound.played.filter((one) => one.cue === "thud").length
    ).toBeGreaterThan(5);
    expect(sound.played.filter((one) => one.cue === "whoosh").length).toBe(1);
  });

  it("replays in silence: a replay runs no frame, and plays nothing", () => {
    const sound = Sound.makeRecorder();
    const app = play(sound, 3);
    app.dispatch(Drop, { height: 1 });
    for (let i = 0; i < 30; i++) {
      app.tick(0.05);
      app.frame();
    }
    expect(sound.played.length).toBeGreaterThan(1);
    const again = Sound.makeRecorder();
    const recording = app.record();
    const replayed = Effect.runSync(
      Journal.replay(recording, Noisy, { checkpointEvery: 1 }).pipe(
        Effect.provide(Sound.layer(again))
      )
    );
    expect(Effect.runSync(replayed.read(World)).hash()).toBe(
      Effect.runSync(app.read(World)).hash()
    );
    expect(again.played).toEqual([]);
  });
});

describe("Sound.makeRecorder", () => {
  it("notes what it was asked to play, oldest first, and plays nothing", () => {
    const sound = Sound.makeRecorder();
    sound.play("a", 1, 1);
    sound.play("b", 0.5, 2);
    expect(sound.played).toEqual([
      { cue: "a", volume: 1, rate: 1 },
      { cue: "b", volume: 0.5, rate: 2 },
    ]);
    // Each its own.
    expect(Sound.makeRecorder().played).toEqual([]);
  });
});
