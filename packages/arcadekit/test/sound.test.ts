import { Cause, Data, Effect, Exit, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

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
  Singleton,
  Sound,
  State,
  System,
  Time,
} from "../src/index";

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): A =>
  Effect.runSync(Effect.scoped(effect));

// --- a game that makes noise -------------------------------------------------------
// Balls fall and bounce off the floor. The simulation says so with an
// event, and knows nothing of sound.
const Ball = Component.define("sd/Ball", { y: Field.f32, speed: Field.f32 });
const Balls = Query.all(Ball);

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

class TooHigh extends Data.TaggedError("TooHigh")<{}> {}

const Fall = System.make("sd/Fall", function* () {
  const { delta } = yield* Time;
  const bounced = yield* Bounced;
  const bounces = yield* Bounces;
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
  components: [Ball, Bounces, Phase],
  systems: [Fall],
  handlers: [
    Action.handler(Drop, function* ({ height }) {
      (yield* Dropped).emit({});

      if (height > 100) {
        return yield* Effect.fail(new TooHigh());
      }

      (yield* Commands).spawn(Ball.of({ y: height, speed: 0 }));
    }),
    Action.handler(Mute, function* ({ on }) {
      (yield* Phase).set(on ? "muted" : "playing");
    }),
  ],
});

const Game = Plugin.make("sd/Game", {
  plugins: [Rules, Sound.plugin],
  systems: [Cues],
});

const play = (output: Sound.OutputShape | undefined, seed = 1) => {
  asked = 0;
  const made = App.make({ plugins: [Game], seed, checkpointEvery: 1 });

  return run(
    output === undefined ? made : made.pipe(Effect.provide(Sound.layer(output)))
  );
};

/** A ball that hits the floor on the next tick, at `speed`. */
const about = (app: App.Any, speed: number): void => {
  app.world.spawn(Ball.of({ y: 0.001, speed }));
};

describe("Sound.cues", () => {
  it("plays what each event sounds like, once, in the frame after it happened", () => {
    const sound = Sound.makeRecorder();
    const app = play(sound);
    app.dispatch(Drop, { height: 5 });
    // Nothing is played until a frame is drawn: not by the action, not by a tick.
    expect(sound.played).toEqual([]);
    app.tick(0.1);
    expect(sound.played).toEqual([]);
    app.frame(0);
    expect(sound.played).toEqual([{ cue: "whoosh", volume: 1, rate: 1 }]);
    // Heard once: the next frames have nothing new to play.
    app.frame(0.5);
    app.tick(0.1);
    app.frame(0);
    expect(sound.played).toHaveLength(1);

    // A payload decides the cue, how loud, and how fast.
    about(app, 5);
    app.tick(0.1);
    app.frame(0);
    expect(sound.played.at(-1)).toEqual({ cue: "thud", volume: 0.6, rate: 1 });
    about(app, 20);
    app.tick(0.1);
    app.frame(0);
    expect(sound.played.at(-1)).toEqual({ cue: "thud", volume: 1, rate: 2 });
    // Or that there is nothing to hear.
    const before = sound.played.length;
    const lines = asked;
    about(app, 0.5);
    app.tick(0.1);
    app.frame(0);
    expect(asked).toBe(lines + 1);
    expect(sound.played).toHaveLength(before);
  });

  it("hears every event of every tick since the last frame, and none twice", () => {
    const sound = Sound.makeRecorder();
    const app = play(sound);
    app.frame(0);
    // Three ticks and then one frame: a drop in the first, a bounce in the last.
    app.enqueue(Drop, { height: 0.001 });
    app.tick(0.1);
    app.tick(0.1);
    about(app, 6);
    app.tick(0.1);
    app.frame(0);
    expect(sound.played.map((one) => one.cue)).toEqual(["whoosh", "thud"]);
    // A frame with no tick before it, and ticks with nothing to say.
    app.frame(0.4);
    app.tick(0.001);
    app.frame(0);
    expect(sound.played).toHaveLength(2);
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
    app.frame(0);
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
    app.frame(0);
    expect(sound.played).toHaveLength(3);
    expect(sound.played[2]!.cue).toBe("thud");
    expect(sound.played[2]!.rate).toBe(1);
  });

  it("makes no sound for what a refused action emitted", () => {
    const sound = Sound.makeRecorder();
    const app = play(sound);
    expect(Exit.isFailure(app.dispatch(Drop, { height: 500 }))).toBe(true);
    app.enqueue(Drop, { height: 500 });
    app.tick(0.1);
    app.frame(0);
    expect(sound.played).toEqual([]);
  });

  it("plays nothing while its system does not run, and nothing later of what happened meanwhile", () => {
    const Quiet = Sound.cues("sd/Quiet", Sound.on(Dropped, "whoosh")).pipe(
      System.runIf(State.is(Phase, "playing"))
    );

    const sound = Sound.makeRecorder();

    const app = run(
      App.make({ plugins: [Rules, Sound.plugin], systems: [Quiet] }).pipe(
        Effect.provide(Sound.layer(sound))
      )
    );

    app.dispatch(Mute, { on: true });
    app.tick(0.1);
    app.dispatch(Drop, { height: 1 });
    app.tick(0.1);
    app.frame(0);
    expect(sound.played).toEqual([]);
    app.dispatch(Mute, { on: false });
    app.tick(0.1);
    app.frame(0);
    expect(sound.played).toEqual([]);
    app.dispatch(Drop, { height: 1 });
    app.tick(0.1);
    app.frame(0);
    expect(sound.played).toEqual([{ cue: "whoosh", volume: 1, rate: 1 }]);
    expect(Quiet.name).toBe("sd/Quiet");
    expect(Quiet.stage).toBe("frame");
  });

  it("reads nothing and plays nothing where sound goes nowhere", () => {
    const app = play(undefined);
    about(app, 5);
    app.dispatch(Drop, { height: 1 });
    app.tick(0.1);
    app.frame(0);
    expect(asked).toBe(0);
    // With an output, the same frame asks.
    const heard = play(Sound.makeRecorder());
    about(heard, 5);
    heard.tick(0.1);
    heard.frame(0);
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
  it("is never called by the simulation: playing in the tick throws", () => {
    const Loud = System.make("sd/Loud", function* () {
      (yield* Sound.Player).play("bang");
    });

    const sound = Sound.makeRecorder();

    const app = run(
      App.make({ plugins: [Sound.plugin], systems: [Loud] }).pipe(
        Effect.provide(Sound.layer(sound))
      )
    );

    expect(() => app.tick(0.1)).toThrow(
      'The cue "bang" was played in the tick'
    );
    expect(sound.played).toEqual([]);

    // Nor by an action's handler, which is the simulation too.
    const Bang = Action.define("sd/Bang", Schema.Struct({}));

    const other = run(
      App.make({
        plugins: [Sound.plugin],
        handlers: [
          Action.handler(Bang, function* () {
            (yield* Sound.Player).play("bang");
          }),
        ],
      }).pipe(Effect.provide(Sound.layer(sound)))
    );

    // It dies of it, as of any bug, and what it did is taken back.
    const exit = other.dispatch(Bang, {});
    expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain(
      'The cue "bang" was played in the tick'
    );
    expect(sound.played).toEqual([]);
  });

  it("plays for a system of the frame stage or the input stage, as it is told, once the frame's systems have run", () => {
    let clicks: readonly (Sound.Options | undefined)[] = [];
    const heard: number[] = [];
    const sound = Sound.makeRecorder();

    const Click = System.make("sd/Click", function* () {
      const player = yield* Sound.Player;

      for (const options of clicks) {
        player.play("click", options);
      }

      // Asked for, and not played yet: the frame is not over.
      heard.push(sound.played.length);
    }).pipe(System.inStage("frame"));

    let beep = false;

    const Beep = System.make("sd/Beep", function* () {
      if (beep) {
        (yield* Sound.Player).play("beep", { volume: 2 });
      }
    }).pipe(System.inStage("input"));

    const app = run(
      App.make({ plugins: [Sound.plugin], systems: [Click, Beep] }).pipe(
        Effect.provide(Sound.layer(sound))
      )
    );

    const frame = (...asked: (Sound.Options | undefined)[]): Sound.Played[] => {
      clicks = asked;
      sound.played.length = 0;
      app.frame(0);

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
    // Asked for in the input stage, it is heard with the frame that
    // follows, and before what that frame asks.
    beep = true;
    app.input();
    expect(sound.played).toEqual([]);
    beep = false;
    expect(frame(undefined)).toEqual([
      { cue: "beep", volume: 2, rate: 1 },
      { cue: "click", volume: 1, rate: 1 },
    ]);
    expect(app.frameOrder).toEqual(["sd/Click", "arcadekit/Sound.Flush"]);
  });

  it("makes one sound of a cue that several systems play in one frame, whichever they are", () => {
    const sound = Sound.makeRecorder();

    const Theirs = Sound.cues(
      "sd/Theirs",
      Sound.on(Bounced, { cue: "thud", volume: 0.3 }),
      Sound.on(Dropped, "whoosh")
    );

    const Mine = System.make("sd/Mine", function* () {
      (yield* Sound.Player).play("whoosh", { volume: 0.2, rate: 2 });
      (yield* Sound.Player).play("ping");
    }).pipe(System.inStage("frame"));

    const app = run(
      App.make({ plugins: [Game], systems: [Theirs, Mine] }).pipe(
        Effect.provide(Sound.layer(sound))
      )
    );

    about(app, 5);
    app.dispatch(Drop, { height: 50 });
    app.tick(0.1);
    app.frame(0);
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

  it("says whether sound goes anywhere", () => {
    const seen: boolean[] = [];

    const Ask = System.make("sd/Ask", function* () {
      seen.push((yield* Sound.Player).audible);
      // Playing to nowhere is no mistake.
      (yield* Sound.Player).play("anything");
    }).pipe(System.inStage("frame"));

    const options = { plugins: [Sound.plugin], systems: [Ask] } as const;
    run(App.make(options)).frame(0);
    run(
      App.make(options).pipe(Effect.provide(Sound.layer(Sound.makeRecorder())))
    ).frame(0);
    expect(seen).toEqual([false, true]);
  });

  it("is what a plugin's systems need: a game with cues that leaves out Sound.plugin does not compile", () => {
    const made = App.make({ plugins: [Rules], systems: [Cues] });
    // @ts-expect-error Sound.Player is still needed: Sound.plugin provides it
    const complete: Effect.Effect<unknown, never, Scope.Scope> = made;

    const withPlugin: Effect.Effect<unknown, never, Scope.Scope> = App.make({
      plugins: [Game],
    });

    expect(complete).toBe(made);
    expect(withPlugin).not.toBe(made);
  });
});

describe("a game with sound", () => {
  it("is the same game as one with none: the same hash, log and save, tick for tick", () => {
    const sound = Sound.makeRecorder();

    const heard = run(
      App.make({
        plugins: [Game],
        seed: 9,
        checkpointEvery: 1,
        verifyFrames: true,
      }).pipe(Effect.provide(Sound.layer(sound)))
    );

    // No output, and no system that plays: the rules alone.
    const deaf = run(
      App.make({ plugins: [Rules], seed: 9, checkpointEvery: 1 })
    );

    for (const app of [heard, deaf]) {
      app.dispatch(Drop, { height: 2 });
      app.dispatch(Drop, { height: 0.5 });
    }

    for (let i = 0; i < 80; i++) {
      heard.tick(0.05);
      heard.frame(0.5);
      deaf.tick(0.05);
      expect(heard.world.hash()).toBe(deaf.world.hash());
    }

    expect(heard.actionLog).toEqual(deaf.actionLog);

    const saves = [heard.save(), deaf.save()].map((save) =>
      Exit.isSuccess(save) ? save.value : undefined
    );

    expect(saves[0]).toBeDefined();
    expect(saves[0]).toEqual(saves[1]);
    // And it was heard: every bounce that was fast enough.
    expect(heard.world.singleton(Bounces).count).toBeGreaterThan(5);
    expect(
      sound.played.filter((one) => one.cue === "thud").length
    ).toBeGreaterThan(5);
    expect(sound.played.filter((one) => one.cue === "whoosh")).toHaveLength(1);
  });

  it("replays in silence: a replay runs no frame, and plays nothing", () => {
    const sound = Sound.makeRecorder();
    const app = play(sound, 3);
    app.dispatch(Drop, { height: 1 });

    for (let i = 0; i < 30; i++) {
      app.tick(0.05);
      app.frame(0);
    }

    expect(sound.played.length).toBeGreaterThan(1);
    const again = Sound.makeRecorder();
    const replayed = play(again, 3);
    App.replay(replayed, app.actionLog, { delta: 0.05, ticks: 30 });
    expect(replayed.world.hash()).toBe(app.world.hash());
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
