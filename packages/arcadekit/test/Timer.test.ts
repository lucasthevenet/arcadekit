import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  Action,
  App,
  Commands,
  Component,
  Field,
  Plugin,
  Query,
  Replay,
  Save,
  Singleton,
  System,
  Time,
  Timeline,
  Timer,
  World,
} from "../src/index.ts";

// --- a shooter: a gun with a cooldown, bullets that last, and waves ---------

const Gun = Component.define("tm/Gun", { cooldown: Timer.field });
const Bullet = Component.define("tm/Bullet", { x: Field.f32 });

/** What happened, and on which tick, kept in the world so a replay has it. */
const Log = Singleton.define(
  "tm/Log",
  {
    firing: Field.u8,
    shots: Field.json<readonly number[]>([]),
    waves: Field.json<readonly number[]>([]),
  },
  { firing: 0, shots: [], waves: [] }
);

const Trigger = Action.define(
  "tm/Trigger",
  Schema.Struct({ held: Schema.Boolean })
);
const Reload = Action.define(
  "tm/Reload",
  Schema.Struct({ seconds: Schema.Number })
);

const trigger = Action.handler(Trigger, function* ({ held }) {
  (yield* Log.writes).firing = held ? 1 : 0;
});
const Guns = Query.all(Gun).pipe(Query.writes(Gun));
const reload = Action.handler(Reload, function* ({ seconds }) {
  (yield* Guns).each((gun) => {
    gun.cooldown = seconds;
  });
});

const COOLDOWN = 1;
const BULLET_LIFE = 0.5;

const Fire = System.tick("tm/Fire", function* () {
  const { delta, tick } = yield* Time;
  const log = yield* Log.writes;
  const commands = yield* Commands.spawns(Bullet, Timer.Lifetime);
  (yield* Guns).each((gun) => {
    gun.cooldown = Timer.tick(gun.cooldown, delta);
    if (log.firing === 1 && Timer.ready(gun.cooldown)) {
      gun.cooldown = COOLDOWN;
      commands.spawn(Bullet.of({ x: 0 }), Timer.lifetime(BULLET_LIFE));
      log.shots = [...log.shots, tick];
    }
  });
});

const Wave = System.tick("tm/Wave", function* () {
  const { tick } = yield* Time;
  const log = yield* Log.writes;
  log.waves = [...log.waves, tick];
}).pipe(Timer.every(1));

const Armed = Plugin.make("tm/Armed", {
  setup: Effect.gen(function* () {
    (yield* Commands.spawns(Gun)).spawn(Gun.of({ cooldown: 0 }));
  }),
});

const Rules = Plugin.make("tm/Rules", {
  plugins: [Timer.plugin, Armed],
  systems: [Fire, Wave],
  handlers: [trigger, reload],
});
const Shooter = App.define({ plugins: [Rules] });

/** A quarter of a second: a sum of these is exact, so ticks are known. */
const DELTA = 0.25;

const Bullets = Query.all(Bullet);

const makeShooter = () => App.make(Shooter);
type ShooterApp = Effect.Success<ReturnType<typeof makeShooter>>;

const run = <E>(
  app: { readonly tick: (delta: number) => Effect.Effect<void, E> },
  ticks: number
) =>
  Effect.gen(function* () {
    for (let i = 0; i < ticks; i++) {
      yield* app.tick(DELTA);
    }
  });

const hashOf = (app: Pick<App.Any, "read">) =>
  Effect.map(app.read(World), (world) => world.hash());

describe("a cooldown", () => {
  it.effect("lets a held trigger fire once each time it runs out", () =>
    Effect.gen(function* () {
      const app = yield* App.make(Shooter);
      yield* app.dispatch(Trigger, { held: true });
      yield* run(app, 12);
      // Ready on the first tick, then once a second: every fourth tick.
      expect((yield* app.read(Log)).shots).toEqual([1, 5, 9]);
    })
  );

  it.effect("is hashed, and leaves nothing behind once it runs out", () =>
    Effect.gen(function* () {
      const long = yield* App.make(Shooter);
      const short = yield* App.make(Shooter);
      yield* long.dispatch(Reload, { seconds: 1 });
      yield* short.dispatch(Reload, { seconds: 0.5 });
      yield* run(long, 2);
      yield* run(short, 2);
      expect(yield* hashOf(long)).not.toBe(yield* hashOf(short));
      yield* run(long, 2);
      yield* run(short, 2);
      expect(yield* hashOf(long)).toBe(yield* hashOf(short));
    })
  );

  it.effect("keeps a game that ticks when needed awake until it runs out", () =>
    Effect.gen(function* () {
      const app = yield* App.make(
        App.define({
          plugins: [Timer.plugin, Armed],
          systems: [Fire],
          handlers: [reload],
        })
      );
      yield* app.dispatch(Reload, { seconds: 1 });
      const settled: boolean[] = [];
      expect(app.settled).toBe(false);
      for (let i = 0; i < 6; i++) {
        yield* app.tick(DELTA);
        settled.push(app.settled);
      }
      // Four ticks count it down, and the fifth changes nothing.
      expect(settled).toEqual([false, false, false, false, true, true]);
    })
  );
});

const Spark = Component.define("tm/Spark", { x: Field.f32 });
const Light = Action.define("tm/Light", Schema.Struct({}));
const Sparks = System.tick("tm/Sparks", function* () {
  (yield* Commands.spawns(Spark, Timer.Lifetime)).spawn(
    Spark.of({ x: 0 }),
    Timer.lifetime(1)
  );
});
const light = Action.handler(Light, function* () {
  const commands = yield* Commands.spawns(Spark, Timer.Lifetime);
  commands.add(commands.spawn(Spark.of({ x: 0 })), Timer.lifetime(1));
});
const Lit = Plugin.make("tm/Lit", {
  setup: Effect.gen(function* () {
    (yield* Commands.spawns(Timer.Lifetime)).spawn(Timer.lifetime(1));
  }),
});

describe("a lifetime", () => {
  it.effect("despawns its entity on the tick it runs out", () =>
    Effect.gen(function* () {
      const app = yield* App.make(Shooter);
      yield* app.dispatch(Trigger, { held: true });
      const counts: number[] = [];
      for (let i = 0; i < 6; i++) {
        yield* app.tick(DELTA);
        counts.push((yield* app.read(Bullets)).count());
      }
      // Spawned on the first tick and the fifth, each there for two ticks.
      expect(counts).toEqual([1, 1, 0, 0, 1, 1]);
    })
  );

  it("does not compile in a game that spawns or adds one and leaves out Timer.plugin", () => {
    const made = {
      system: App.make(App.define({ systems: [Sparks] })),
      handler: App.make(App.define({ handlers: [light] })),
      setup: App.make(App.define({ plugins: [Lit] })),
    };
    expectTypeOf<Effect.Services<(typeof made)["system"]>>().toEqualTypeOf<
      Plugin.Installed<"arcadekit/Timer">
    >();
    expectTypeOf<Effect.Services<(typeof made)["handler"]>>().toEqualTypeOf<
      Plugin.Installed<"arcadekit/Timer">
    >();
    expectTypeOf<Effect.Services<(typeof made)["setup"]>>().toEqualTypeOf<
      Plugin.Installed<"arcadekit/Timer">
    >();
  });

  it("compiles in a game that lists Timer.plugin, itself or through one of its plugins", () => {
    expectTypeOf(
      App.make(App.define({ plugins: [Timer.plugin], systems: [Sparks] }))
    ).toExtend<Effect.Effect<unknown, never>>();
    expectTypeOf(
      App.make(
        App.define({
          plugins: [Plugin.make("tm/Fire", { plugins: [Timer.plugin, Lit] })],
          handlers: [light],
        })
      )
    ).toExtend<Effect.Effect<unknown, never>>();
  });

  it("still needs Timer.plugin beside a plugin whose name the compiler knows only as a string", () => {
    const name: string = "arcadekit/Timer";
    const made = App.make(
      App.define({ plugins: [Plugin.make(name, {})], systems: [Sparks] })
    );
    expectTypeOf<Effect.Services<typeof made>>().toEqualTypeOf<
      Plugin.Installed<"arcadekit/Timer">
    >();
  });
});

describe("a system that runs every so often", () => {
  it.effect("runs on the first tick at or after each period", () =>
    Effect.gen(function* () {
      const app = yield* App.make(Shooter);
      const delta = 0.375;
      const expected: number[] = [];
      for (let tick = 1; tick <= 20; tick++) {
        yield* app.tick(delta);
        if (Math.floor(tick * delta) > Math.floor((tick - 1) * delta)) {
          expected.push(tick);
        }
      }
      expect((yield* app.read(Log)).waves).toEqual(expected);
      expect(expected.slice(0, 4)).toEqual([3, 6, 8, 11]);
    })
  );

  it.effect("runs once on a tick longer than its period", () =>
    Effect.gen(function* () {
      const app = yield* App.make(Shooter);
      yield* app.tick(2.5);
      yield* app.tick(0.25);
      yield* app.tick(2.5);
      expect((yield* app.read(Log)).waves).toEqual([1, 3]);
    })
  );

  it.effect(
    "waits while an earlier condition keeps it from being checked",
    () =>
      Effect.gen(function* () {
        const Gate = Singleton.define(
          "tm/Gate",
          { open: Field.u8 },
          { open: 1 }
        );
        const Shut = Action.define("tm/Shut", Schema.Struct({}));
        const shut = Action.handler(Shut, function* () {
          (yield* Gate.writes).open = 0;
        });
        const Gated = System.tick("tm/Gated", function* () {
          const log = yield* Log.writes;
          log.waves = [...log.waves, (yield* Time).tick];
        }).pipe(
          System.runIf(Effect.map(Gate.asEffect(), (gate) => gate.open === 1)),
          Timer.every(1)
        );
        const app = yield* App.make(
          App.define({ systems: [Gated], handlers: [shut] })
        );
        yield* run(app, 2);
        yield* app.dispatch(Shut, {});
        yield* run(app, 10);
        expect((yield* app.read(Log)).waves).toEqual([]);
      })
  );

  it("refuses a period that is not a positive number", () => {
    const Idle = System.tick("tm/Idle", function* () {});
    for (const seconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => Idle.pipe(Timer.every(seconds))).toThrow(
        `Timer.every(${seconds}) on system "tm/Idle"`
      );
    }
  });

  it("does not compile on a system of the frame", () => {
    const Draw = System.frame("tm/Draw", function* () {});
    // @ts-expect-error a frame system has no game time to count
    expect(() => Timer.every(Draw, 1)).not.toThrow();
    // @ts-expect-error in a pipe as well
    expect(() => Draw.pipe(Timer.every(1))).not.toThrow();
    const Late = System.tick("tm/Late", function* () {}).pipe(
      System.inStage("postUpdate"),
      Timer.every(1)
    );
    expect(Late.stage).toBe("postUpdate");
  });
});

// --- what the timers are across saves, rewinds and replays -------------------

/** A game that fires, stops and fires again, and what it logged. */
const played = (app: ShooterApp, from: number, to: number) =>
  Effect.gen(function* () {
    for (let tick = from; tick < to; tick++) {
      if (tick === 3) {
        yield* app.enqueue(Trigger, { held: true });
      }
      if (tick === 14) {
        yield* app.enqueue(Trigger, { held: false });
      }
      if (tick === 17) {
        yield* app.enqueue(Trigger, { held: true });
      }
      yield* app.tick(DELTA);
    }
    return { log: yield* app.read(Log), hash: yield* hashOf(app) };
  });

describe("timers in the world", () => {
  it.effect("fire on the same ticks in a replay", () =>
    Effect.gen(function* () {
      const app = yield* App.make(Shooter, { seed: 3 });
      const first = yield* played(app, 0, 30);
      expect(first.log.shots.length).toBeGreaterThan(3);
      expect(first.log.waves.length).toBe(7);
      const again = yield* Replay.verify(yield* Replay.record(app), Shooter, {
        hashEvery: 1,
      });
      expect(yield* again.read(Log)).toEqual(first.log);
      expect(yield* hashOf(again)).toBe(first.hash);
    })
  );

  it.effect("go on from a save as they would have", () =>
    Effect.gen(function* () {
      const whole = yield* played(yield* App.make(Shooter), 0, 30);
      const app = yield* App.make(Shooter);
      // Mid-cooldown and mid-period.
      yield* played(app, 0, 11);
      const loaded = yield* App.make(Shooter, { save: yield* Save.make(app) });
      expect(yield* played(loaded, 11, 30)).toEqual(whole);
    })
  );

  it.effect("are put back by a rewind", () =>
    Effect.gen(function* () {
      const app = yield* App.make(Shooter);
      yield* played(app, 0, 11);
      const moment = yield* Timeline.capture(app);
      const first = yield* played(app, 11, 30);
      yield* Timeline.rewind(app, moment);
      expect(yield* played(app, 11, 30)).toEqual(first);
    })
  );
});
