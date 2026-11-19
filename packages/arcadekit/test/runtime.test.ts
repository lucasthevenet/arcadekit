import { Cause, Context, Data, Effect, Exit, Layer, Logger } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  Action,
  App,
  Commands,
  Component,
  Driver,
  Events,
  Field,
  Query,
  Random,
  Resource,
  Script,
  System,
  TickScheduler,
  Time,
  World,
} from "../src/index";

const Position = Component.define("rt/Position", {
  x: Field.f32,
  y: Field.f32,
});

const Velocity = Component.define("rt/Velocity", {
  x: Field.f32,
  y: Field.f32,
});

const Lifetime = Component.define("rt/Lifetime", { seconds: Field.f32 });
const Stunned = Component.tag("rt/Stunned", { storage: "sparse" });

const Moving = Query.all(Position, Velocity).pipe(Query.without(Stunned));

const Movement = System.make("Movement", function* () {
  const moving = yield* Moving;
  const { delta } = yield* Time;
  moving.each((pos, vel) => {
    pos.x += vel.x * delta;
    pos.y += vel.y * delta;
  });
});

/** Builds an app, hands it to `use`, then closes its scope. */
const withApp = <T, A>(
  make: Effect.Effect<T, never, Scope.Scope>,
  use: (app: T) => A
): A => Effect.runSync(Effect.scoped(Effect.map(make, use)));

describe("systems", () => {
  it("run with yieldable queries and game time", () => {
    withApp(App.make({ systems: [Movement] }), (app) => {
      const a = app.world.spawn(
        Position.of({ x: 0, y: 0 }),
        Velocity.of({ x: 2, y: 4 })
      );

      const b = app.world.spawn(
        Position.of({ x: 0, y: 0 }),
        Velocity.of({ x: 2, y: 4 }),
        Stunned
      );

      app.tick(0.5);
      app.tick(0.5);
      expect(app.world.get(a, Position)).toStrictEqual({ x: 2, y: 4 });
      expect(app.world.get(b, Position)).toStrictEqual({ x: 0, y: 0 });
      expect(app.time).toStrictEqual({ delta: 0.5, elapsed: 1, tick: 2 });
    });
  });

  it("are ordered by stage, then by `after`, then by registration", () => {
    const log: string[] = [];

    const sys = (name: string) =>
      System.make(name, function* () {
        yield* Effect.sync(() => log.push(name));
      });

    const systems = [
      sys("render").pipe(System.inStage("postUpdate")),
      sys("c").pipe(System.after("a")),
      sys("b"),
      sys("a").pipe(System.after("b")),
      sys("input").pipe(System.inStage("preUpdate")),
    ];

    withApp(App.make({ systems }), (app) => {
      expect(app.systemOrder).toStrictEqual(["input", "b", "a", "c", "render"]);
      app.tick(1);
      expect(log).toStrictEqual(["input", "b", "a", "c", "render"]);
    });
    expect(() =>
      System.order([
        sys("x").pipe(System.after("y")),
        sys("y").pipe(System.after("x")),
      ])
    ).toThrow(/Circular/u);
    expect(() => System.order([sys("x").pipe(System.after("nope"))])).toThrow(
      /not in the "update" stage/u
    );

    // `before` slots a system in ahead of one registered earlier.
    const names = (list: readonly System.System<any, any>[]) =>
      System.order(list).map((s) => s.name);

    expect(
      names([sys("p"), sys("q"), sys("r").pipe(System.before("p"))])
    ).toStrictEqual(["r", "p", "q"]);
    expect(
      names([
        sys("p"),
        sys("q").pipe(System.after("r")),
        sys("r").pipe(System.before("p")),
      ])
    ).toStrictEqual(["r", "p", "q"]);
    expect(() =>
      System.order([
        sys("x").pipe(System.before("y")),
        sys("y").pipe(System.before("x")),
      ])
    ).toThrow(/Circular/u);
    expect(() => System.order([sys("x").pipe(System.before("nope"))])).toThrow(
      /must run before "nope"/u
    );
  });

  it("see each other's commands as soon as the earlier system finishes", () => {
    const Spawner = System.make("Spawner", function* () {
      const commands = yield* Commands;
      const { tick } = yield* Time;

      if (tick === 1) {
        commands.spawn(
          Position.of({ x: 0, y: 0 }),
          Lifetime.of({ seconds: 1 })
        );
      }
    });

    const counts: number[] = [];

    const Reaper = System.make("Reaper", function* () {
      const commands = yield* Commands;
      const { delta } = yield* Time;
      const mortal = yield* Query.all(Lifetime);
      counts.push(mortal.count());
      mortal.each((life, entity) => {
        life.seconds -= delta;

        // Despawning directly here would throw; the command is applied after the loop.
        if (life.seconds <= 0) {
          commands.despawn(entity);
        }
      });
    }).pipe(System.after(Spawner));

    withApp(App.make({ systems: [Reaper, Spawner] }), (app) => {
      app.tick(0.5);
      expect(app.world.entityCount).toBe(1);
      app.tick(0.5);
      expect(app.world.entityCount).toBe(0);
      app.tick(0.5);
      expect(counts).toStrictEqual([1, 1, 0]);
    });
  });

  it("read and write sparse components as query data, with either loop style", () => {
    const Health = Component.define("rt/Health", { hp: Field.f32 });

    const Burning = Component.define(
      "rt/Burning",
      { seconds: Field.f32, dps: Field.f32 },
      { storage: "sparse" }
    );

    const OnFire = Query.all(Health, Burning);

    const Burn = System.make("Burn", function* () {
      const onFire = yield* OnFire;
      const { delta } = yield* Time;
      onFire.each((health, burning) => {
        health.hp -= burning.dps * delta;
      });
    });

    const Extinguish = System.make("Extinguish", function* () {
      const onFire = yield* OnFire;
      const commands = yield* Commands;
      const { delta } = yield* Time;
      onFire.eachChunk((start, end, _health, burning, entities) => {
        const { seconds } = burning.columns;

        for (let i = start; i < end; i += 1) {
          const row = burning.indexOf(entities[i]!);
          seconds[row]! -= delta;

          // Removing a sparse component is cheap: the entity stays in its table.
          if (seconds[row]! <= 0) {
            commands.remove(entities[i]!, Burning);
          }
        }
      });
    }).pipe(System.after(Burn));

    withApp(App.make({ systems: [Burn, Extinguish] }), (app) => {
      const torch = app.world.spawn(
        Health.of({ hp: 100 }),
        Burning.of({ seconds: 2, dps: 10 })
      );

      const rock = app.world.spawn(Health.of({ hp: 100 }));
      const tables = app.world.tables.length;

      for (let i = 0; i < 4; i += 1) {
        app.tick(1);
      }

      expect(app.world.get(torch, Health)).toStrictEqual({ hp: 80 });
      expect(app.world.get(rock, Health)).toStrictEqual({ hp: 100 });
      expect(app.world.has(torch, Burning)).toBe(false);
      expect(app.world.tables).toHaveLength(tables);
    });
  });

  it("read resources with defaults that a layer can override", () => {
    const Gravity = Resource.make("rt/Gravity", { defaultValue: () => 9.81 });
    const seen: number[] = [];

    const ReadGravity = System.make("ReadGravity", function* () {
      seen.push(yield* Gravity);
    });

    withApp(App.make({ systems: [ReadGravity] }), (app) => app.tick(1));
    withApp(
      App.make({ systems: [ReadGravity] }).pipe(
        Effect.provide(Resource.layer(Gravity, 1.62))
      ),
      (app) => app.tick(1)
    );
    expect(seen).toStrictEqual([9.81, 1.62]);
  });

  it("get their services the usual Effect way, and a missing one does not compile", () => {
    class Audio extends Context.Service<
      Audio,
      { readonly play: (sound: string) => void }
    >()("rt/Audio") {}

    const played: string[] = [];

    const Beep = System.make("Beep", function* () {
      const audio = yield* Audio;
      const things = yield* Query.all(Position);
      audio.play(`beep x${things.count()}`);
    });

    // Written inline on purpose: this is how layers are usually provided.
    const make = App.make({ systems: [Beep] }).pipe(
      Effect.provide(
        Layer.succeed(Audio, {
          play: (sound) => {
            played.push(sound);
          },
        })
      )
    );

    withApp(make, (app) => {
      app.world.spawn(Position.of({ x: 1, y: 1 }));
      app.tick(1);
    });
    expect(played).toStrictEqual(["beep x1"]);

    // Forgetting the layer leaves `Audio` as an unmet requirement.
    expect(() =>
      withApp(
        // @ts-expect-error Audio is not provided
        App.make({ systems: [Beep] }),
        (app) => app.tick(1)
      )
    ).toThrow();
  });

  it("surface typed failures through tickExit, and tick() throws them", () => {
    class OutOfBounds extends Data.TaggedError("OutOfBounds")<{
      readonly x: number;
    }> {}

    const Bounds = System.make("Bounds", function* () {
      const things = yield* Query.all(Position);
      let worst = 0;
      things.each((pos) => {
        worst = Math.max(worst, pos.x);
      });

      if (worst > 100) {
        return yield* Effect.fail(new OutOfBounds({ x: worst }));
      }
    });

    withApp(App.make({ systems: [Bounds] }), (app) => {
      app.world.spawn(Position.of({ x: 5, y: 0 }));
      expect(Exit.isSuccess(app.tickExit(1))).toBe(true);
      app.world.spawn(Position.of({ x: 500, y: 0 }));
      const exit = app.tickExit(1);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(() => app.tick(1)).toThrow(OutOfBounds);
    });
  });

  it("must finish within the tick", () => {
    const Lazy = System.make("Lazy", function* () {
      const script = yield* Script;
      yield* script.nextTick;
    });

    withApp(App.make({ systems: [Lazy] }), (app) => {
      expect(() => app.tick(1)).toThrow(
        /"Lazy" did not finish within the tick/u
      );
      // The app is still usable afterwards.
      expect(() => app.tick(1)).toThrow(/did not finish/u);
    });
  });
});

describe("the built-in services", () => {
  it("are keyed under arcadekit/, each with its own key", () => {
    // A key is a service's identity: two services with one key silently
    // become one, and a game's own "World" must not collide with these.
    const keys = [
      World,
      Time,
      Commands,
      Script,
      Events,
      Random,
      Action.Actions,
    ].map((service) => service.key);

    expect(keys).toStrictEqual([
      "arcadekit/World",
      "arcadekit/Time",
      "arcadekit/Commands",
      "arcadekit/Script",
      "arcadekit/Events",
      "arcadekit/Random",
      "arcadekit/Actions",
    ]);
  });

  it("leave a game free to define a service called World", () => {
    class GameWorld extends Context.Service<
      GameWorld,
      { readonly size: number }
    >()("World") {}

    const Probe = System.make("Probe", function* () {
      const world = yield* World;
      const mine = yield* GameWorld;
      world.spawn(Lifetime.of({ seconds: mine.size }));
    });

    withApp(
      App.make({ systems: [Probe] }).pipe(
        Effect.provideService(GameWorld, { size: 7 })
      ),
      (app) => {
        app.tick(1);
        expect(app.world.entityCount).toBe(1);
      }
    );
  });
});

describe("the tick scheduler", () => {
  // 10,000 flatMaps is far past Effect's default budget of 2048 operations.
  const busy = Effect.gen(function* () {
    let total = 0;

    for (let i = 0; i < 10_000; i += 1) {
      total += yield* Effect.sync(() => 1);
    }

    return total;
  });

  it("documents the problem: the default scheduler pauses a long fiber mid-run", async () => {
    const fiber = Effect.runFork(busy);
    // Not done synchronously: it yielded and will resume from a timer.
    expect(fiber.pollUnsafe()).toBeUndefined();

    const exit = await new Promise<Exit.Exit<number>>((resolve) =>
      fiber.addObserver(resolve)
    );

    expect(exit).toStrictEqual(Exit.succeed(10_000));
  });

  it("never pauses a fiber mid-tick", () => {
    const fiber = Effect.runFork(busy, { scheduler: new TickScheduler() });
    expect(fiber.pollUnsafe()).toStrictEqual(Exit.succeed(10_000));
  });

  it("lets a heavy system finish inside its tick", () => {
    let total = 0;

    const Heavy = System.make("Heavy", function* () {
      total = yield* busy;
    });

    withApp(App.make({ systems: [Heavy] }), (app) => {
      app.tick(1);
      expect(total).toBe(10_000);
    });
  });

  it("only resumes yielded fibers when the tick flushes", async () => {
    const log: string[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* App.make({ systems: [] });
          app.spawnScript(
            Effect.gen(function* () {
              log.push("start");
              yield* Effect.yieldNow;
              log.push("after yieldNow");
            })
          );
          expect(log).toStrictEqual(["start"]);
          expect(app.dispatcher.pending).toBe(1);
          // Give timers and microtasks every chance to run it behind our back.
          yield* Effect.promise(
            () => new Promise((resolve) => setTimeout(resolve, 20))
          );
          expect(log).toStrictEqual(["start"]);
          app.tick(1);
          expect(log).toStrictEqual(["start", "after yieldNow"]);
          expect(app.dispatcher.pending).toBe(0);
        })
      )
    );
  });

  it("stops a fiber that spins on yieldNow instead of hanging the tick", () => {
    withApp(App.make({ systems: [] }), (app) => {
      app.dispatcher.maxRounds = 50;
      app.spawnScript(Effect.forever(Effect.yieldNow));
      expect(() => app.tick(1)).toThrow(/still busy after 50 rounds/u);
    });
  });
});

describe("scripts", () => {
  it("advance only during ticks, in a fixed order", () => {
    const log: string[] = [];

    const script = (name: string, waits: number) =>
      Effect.gen(function* () {
        const { nextTick } = yield* Script;

        for (let i = 0; i < waits; i += 1) {
          yield* nextTick;
          log.push(`${name}@${(yield* Time).tick}`);
        }

        return name;
      });

    withApp(App.make({ systems: [] }), (app) => {
      const a = app.spawnScript(script("a", 2));
      const b = app.spawnScript(script("b", 1));
      expect(log).toStrictEqual([]);
      app.tick(1);
      expect(log).toStrictEqual(["a@1", "b@1"]);
      expect(b.pollUnsafe()).toStrictEqual(Exit.succeed("b"));
      expect(a.pollUnsafe()).toBeUndefined();
      app.tick(1);
      expect(log).toStrictEqual(["a@1", "b@1", "a@2"]);
      expect(a.pollUnsafe()).toStrictEqual(Exit.succeed("a"));
    });
  });

  it("sleep in game time, and can change the world through commands", () => {
    const Bomb = Effect.gen(function* () {
      const script = yield* Script;
      const commands = yield* Commands;
      const bomb = commands.spawn(Position.of({ x: 3, y: 3 }));
      yield* script.sleep(1);
      commands.despawn(bomb);

      return (yield* Time).tick;
    });

    withApp(App.make({ systems: [Movement] }), (app) => {
      const fiber = app.spawnScript(Bomb);
      const step = Driver.fixedStep(app, { hz: 60, maxStepsPerCall: 1000 });
      step(0.5);
      expect(app.world.entityCount).toBe(1);
      step(0.6);
      expect(app.world.entityCount).toBe(0);
      // 60 ticks of 1/60 s is one second of game time, however long it really took.
      expect(fiber.pollUnsafe()).toStrictEqual(Exit.succeed(60));
    });
  });

  it("can be started from a system with forkDetach", () => {
    const log: string[] = [];

    const Starter = System.make("Starter", function* () {
      const { tick } = yield* Time;

      if (tick !== 1) {
        return;
      }

      yield* Effect.forkDetach(
        Effect.gen(function* () {
          const { nextTick } = yield* Script;
          log.push(`started@${(yield* Time).tick}`);
          yield* nextTick;
          log.push(`resumed@${(yield* Time).tick}`);
        })
      );
    });

    withApp(App.make({ systems: [Starter] }), (app) => {
      app.tick(1);
      expect(log).toStrictEqual(["started@1"]);
      app.tick(1);
      expect(log).toStrictEqual(["started@1", "resumed@2"]);
    });
  });

  it("are interrupted when the app's scope closes", () => {
    let cleanedUp = false;

    const fiber = withApp(App.make({ systems: [] }), (app) =>
      app.spawnScript(
        Effect.gen(function* () {
          const { nextTick } = yield* Script;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              cleanedUp = true;
            })
          );
          yield* Effect.forever(nextTick);
        }).pipe(Effect.scoped)
      )
    );

    expect(cleanedUp).toBe(true);
    const exit = fiber.pollUnsafe();
    expect(exit !== undefined && Exit.isFailure(exit)).toBe(true);
  });
});

/** A logger that keeps what it is given, as a layer for `App.make`. */
const capturedLogs = () => {
  const entries: {
    readonly level: string;
    readonly message: string;
    readonly cause: Cause.Cause<unknown>;
  }[] = [];

  const logger = Logger.make<unknown, void>((options) => {
    entries.push({
      level: options.logLevel,
      message: String(options.message),
      cause: options.cause,
    });
  });

  return { entries, layer: Logger.layer([logger]) };
};

class Tripped extends Data.TaggedError("Tripped")<{
  readonly on: string;
}> {}

describe("a script that fails", () => {
  /** Waits `ticks` ticks, then fails. */
  const trips = (ticks: number, on = "a wire") =>
    Effect.gen(function* () {
      const { nextTick } = yield* Script;

      for (let i = 0; i < ticks; i += 1) {
        yield* nextTick;
      }

      return yield* Effect.fail(new Tripped({ on }));
    });

  it("is logged with its cause, once, and the game goes on without it", () => {
    const logs = capturedLogs();
    withApp(
      App.make({ systems: [Movement] }).pipe(Effect.provide(logs.layer)),
      (app) => {
        const fiber = app.spawnScript(trips(2));
        app.tick(1);
        expect(logs.entries).toStrictEqual([]);
        app.tick(1);
        expect(logs.entries).toHaveLength(1);
        const [entry] = logs.entries;
        expect(entry!.level).toBe("Error");
        expect(entry!.message).toBe("A script failed at tick 2");
        expect(Cause.squash(entry!.cause)).toStrictEqual(
          new Tripped({ on: "a wire" })
        );
        // The same cause the fiber ended with, for whoever observes it.
        const exit = fiber.pollUnsafe();
        expect(exit !== undefined && Exit.isFailure(exit) && exit.cause).toBe(
          entry!.cause
        );

        app.tick(1);
        app.tick(1);
        expect(app.time.tick).toBe(4);
        expect(logs.entries).toHaveLength(1);
      }
    );
  });

  it("is logged whether it fails with an error or dies of a defect, even before its first wait", () => {
    const logs = capturedLogs();
    withApp(
      App.make({ systems: [] }).pipe(Effect.provide(logs.layer)),
      (app) => {
        app.spawnScript(Effect.die(new Error("a bug")));
        expect(logs.entries.map((entry) => entry.message)).toStrictEqual([
          "A script failed at tick 0",
        ]);
        expect(Cause.squash(logs.entries[0]!.cause)).toStrictEqual(
          new Error("a bug")
        );
        app.spawnScript(trips(0, "the doorstep"));
        expect(logs.entries).toHaveLength(2);
        expect(Cause.squash(logs.entries[1]!.cause)).toStrictEqual(
          new Tripped({ on: "the doorstep" })
        );
        // Each of two scripts that fail in one tick is reported.
        app.spawnScript(trips(1, "one"));
        app.spawnScript(trips(1, "two"));
        app.tick(1);
        expect(
          logs.entries.slice(2).map((entry) => Cause.squash(entry.cause))
        ).toStrictEqual([
          new Tripped({ on: "one" }),
          new Tripped({ on: "two" }),
        ]);
      }
    );
  });

  it("is not reported when it finishes, or is interrupted, or the app's scope closes", () => {
    const logs = capturedLogs();
    withApp(
      App.make({ systems: [], onScriptFailure: "stop" }).pipe(
        Effect.provide(logs.layer)
      ),
      (app) => {
        const forever = Effect.gen(function* () {
          yield* Effect.forever((yield* Script).nextTick);
        });

        app.spawnScript(Effect.succeed("done at once"));
        app.spawnScript(
          Effect.gen(function* () {
            yield* (yield* Script).nextTick;

            return "done later";
          })
        );
        const interrupted = app.spawnScript(forever);
        app.spawnScript(forever);
        app.tick(1);
        interrupted.interruptUnsafe();
        app.tick(1);
        app.tick(1);
        // Stopping on a failed script, and none of these failed.
        expect(app.time.tick).toBe(3);
      }
    );
    expect(logs.entries).toStrictEqual([]);
  });

  it("is watched the same way when a system starts it with Script.spawn", () => {
    const logs = capturedLogs();
    const order: string[] = [];
    let cleanedUp = false;

    const Starter = System.make("Starter", function* () {
      const script = yield* Script;

      if ((yield* Time).tick !== 1) {
        return;
      }

      const fiber = yield* script.spawn(
        Effect.gen(function* () {
          order.push("script started");
          yield* script.nextTick;

          return yield* Effect.fail(new Tripped({ on: "a system's script" }));
        })
      );

      // It has not run yet: it starts when the tick flushes, after the systems.
      order.push(`spawned, running: ${fiber.pollUnsafe() === undefined}`);
      yield* script.spawn(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              cleanedUp = true;
            })
          );
          yield* Effect.forever(script.nextTick);
        }).pipe(Effect.scoped)
      );
    });

    const After = System.make("After", function* () {
      order.push(`After@${(yield* Time).tick}`);
    });

    withApp(
      App.make({ systems: [Starter, After] }).pipe(Effect.provide(logs.layer)),
      (app) => {
        app.tick(1);
        expect(order).toStrictEqual([
          "spawned, running: true",
          "After@1",
          "script started",
        ]);
        expect(logs.entries).toStrictEqual([]);
        app.tick(1);
        expect(logs.entries.map((entry) => entry.message)).toStrictEqual([
          "A script failed at tick 2",
        ]);
        expect(Cause.squash(logs.entries[0]!.cause)).toStrictEqual(
          new Tripped({ on: "a system's script" })
        );
        expect(cleanedUp).toBe(false);
      }
    );
    // The other script was still running, and the scope's end interrupted it.
    expect(cleanedUp).toBe(true);
    expect(logs.entries).toHaveLength(1);
  });

  it("is not watched when it was started with forkDetach, which is the caller's fiber", () => {
    const logs = capturedLogs();

    const Starter = System.make("Starter", function* () {
      if ((yield* Time).tick === 1) {
        yield* Effect.forkDetach(trips(1));
      }
    });

    withApp(
      App.make({ systems: [Starter], onScriptFailure: "stop" }).pipe(
        Effect.provide(logs.layer)
      ),
      (app) => {
        app.tick(1);
        app.tick(1);
        app.tick(1);
        expect(app.time.tick).toBe(3);
      }
    );
    expect(logs.entries).toStrictEqual([]);
  });

  it("stops the app when it was told to: the tick ends, fails with ScriptFailed, and no later tick runs", () => {
    const logs = capturedLogs();
    let ran = 0;

    const Counter = System.make("Counter", function* () {
      ran += 1;
    });

    withApp(
      App.make({ systems: [Counter], onScriptFailure: "stop" }).pipe(
        Effect.provide(logs.layer)
      ),
      (app) => {
        const fiber = app.spawnScript(
          Effect.gen(function* () {
            const commands = yield* Commands;
            yield* (yield* Script).nextTick;
            yield* (yield* Script).nextTick;
            commands.spawn(Lifetime.of({ seconds: 1 }));

            return yield* Effect.fail(new Tripped({ on: "tick two" }));
          })
        );

        expect(app.tickExit(1)).toStrictEqual(Exit.void);

        const exit = app.tickExit(1);

        const failure = Exit.isFailure(exit)
          ? Cause.squash(exit.cause)
          : undefined;

        expect(failure).toBeInstanceOf(App.ScriptFailed);
        const stopped = failure as App.ScriptFailed;
        expect(stopped.tick).toBe(2);
        expect(Cause.squash(stopped.cause)).toStrictEqual(
          new Tripped({ on: "tick two" })
        );
        const ended = fiber.pollUnsafe();
        expect(
          ended !== undefined && Exit.isFailure(ended) && ended.cause
        ).toBe(stopped.cause);
        expect(stopped.message).toMatch(/A script failed at tick 2/u);
        expect(stopped.message).toMatch(/Tripped/u);
        // A defect, not a typed failure: nothing is expected to recover from it.
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
        // The tick the script failed in ran to its end first.
        expect(ran).toBe(2);
        expect(app.time.tick).toBe(2);
        expect(app.world.entityCount).toBe(1);

        // From here on a tick runs nothing and fails the same way.
        expect(() => app.tick(1)).toThrow(stopped);
        expect(app.tickExit(1)).toStrictEqual(Exit.die(stopped));
        const step = Driver.fixedStep(app, { hz: 60 });
        expect(() => step(1)).toThrow(App.ScriptFailed);
        expect(ran).toBe(2);
        expect(app.time).toStrictEqual({ delta: 1, elapsed: 2, tick: 2 });
        // It is logged as well, once.
        expect(logs.entries.map((entry) => entry.message)).toStrictEqual([
          "A script failed at tick 2",
        ]);
      }
    );
  });

  it("stops the app before its next tick when it fails between ticks, and keeps the first failure", () => {
    let ran = 0;

    const Counter = System.make("Counter", function* () {
      ran += 1;
    });

    const logs = capturedLogs();
    withApp(
      App.make({ systems: [Counter], onScriptFailure: "stop" }).pipe(
        Effect.provide(logs.layer)
      ),
      (app) => {
        app.tick(1);
        app.spawnScript(trips(0, "first"));
        app.spawnScript(trips(0, "second"));
        const exit = app.tickExit(1);

        const stopped = (
          Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        ) as App.ScriptFailed;

        expect(stopped).toBeInstanceOf(App.ScriptFailed);
        expect(stopped.tick).toBe(1);
        expect(Cause.squash(stopped.cause)).toStrictEqual(
          new Tripped({ on: "first" })
        );
        expect(ran).toBe(1);
        expect(app.time.tick).toBe(1);
        expect(logs.entries).toHaveLength(2);
      }
    );
  });

  it("does not hide a system's failure in the tick they both fail in", () => {
    class Jammed extends Data.TaggedError("Jammed") {}

    const Jam = System.make("Jam", function* () {
      if ((yield* Time).tick === 2) {
        return yield* Effect.fail(new Jammed());
      }
    });

    withApp(
      App.make({ systems: [Jam], onScriptFailure: "stop" }).pipe(
        Effect.provide(capturedLogs().layer)
      ),
      (app) => {
        app.spawnScript(trips(2));
        app.tick(1);
        expect(app.tickExit(1)).toStrictEqual(Exit.fail(new Jammed()));
        const next = app.tickExit(1);
        expect(Exit.isFailure(next) && Cause.squash(next.cause)).toBeInstanceOf(
          App.ScriptFailed
        );
        expect(app.time.tick).toBe(2);
      }
    );
  });

  it("goes to the default logger when no other is provided", () => {
    const seen: unknown[][] = [];
    const original = console.error;
    const originalLog = console.log;
    console.error = (...args: unknown[]) => {
      seen.push(args);
    };
    console.log = (...args: unknown[]) => {
      seen.push(args);
    };

    try {
      withApp(App.make({ systems: [] }), (app) => {
        app.spawnScript(trips(1, "the default logger"));
        app.tick(1);
      });
    } finally {
      console.error = original;
      console.log = originalLog;
    }

    const text = seen.flat().join(" ");
    expect(text).toMatch(/A script failed at tick 1/u);
    expect(text).toMatch(/Tripped/u);
  });
});

describe("determinism", () => {
  it("replays identically from the same inputs", () => {
    const run = () => {
      const trace: string[] = [];

      const Bounce = System.make("Bounce", function* () {
        const moving = yield* Moving;
        moving.each((pos, vel) => {
          if (pos.x > 10 || pos.x < 0) {
            vel.x = -vel.x;
          }
        });
      }).pipe(System.after(Movement));

      withApp(App.make({ systems: [Movement, Bounce] }), (app) => {
        for (let i = 0; i < 50; i += 1) {
          app.world.spawn(
            Position.of({ x: i % 10, y: 0 }),
            Velocity.of({ x: (i % 7) - 3, y: 0 })
          );
        }

        app.spawnScript(
          Effect.gen(function* () {
            const script = yield* Script;
            const commands = yield* Commands;

            for (let i = 0; i < 20; i += 1) {
              yield* script.sleep(0.1);
              commands.spawn(
                Position.of({ x: 5, y: i }),
                Velocity.of({ x: i, y: 0 })
              );
            }
          })
        );
        const step = Driver.fixedStep(app, { hz: 60, maxStepsPerCall: 10_000 });
        step(5);
        const all = app.world.view(Moving);
        all.each((pos, vel, entity) => {
          trace.push(`${entity}:${pos.x},${pos.y},${vel.x}`);
        });
        trace.push(`ticks=${app.time.tick} entities=${app.world.entityCount}`);
      });

      return trace;
    };

    const first = run();
    expect(first).toHaveLength(71);
    expect(run()).toStrictEqual(first);
  });
});

describe("the fixed-step driver", () => {
  it("runs exactly hz ticks per second of input, however the time is sliced", () => {
    withApp(App.make({ systems: [] }), (app) => {
      const step = Driver.fixedStep(app, { hz: 60, maxStepsPerCall: 1000 });
      expect(step(1)).toBe(60);
      expect(step(1)).toBe(60);

      for (let i = 0; i < 1000; i += 1) {
        step(0.001);
      }

      expect(app.time.tick).toBe(180);
      expect(step(0.01)).toBe(0);
      expect(step(0.01)).toBe(1);
    });
  });

  it("drops the backlog after a stall instead of spiralling", () => {
    withApp(App.make({ systems: [] }), (app) => {
      const step = Driver.fixedStep(app, { hz: 60 });
      expect(step(10)).toBe(5);
      expect(step(1 / 60)).toBe(1);
    });
  });
});
