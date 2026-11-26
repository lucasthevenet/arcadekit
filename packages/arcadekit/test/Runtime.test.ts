import { assert, describe, expect, it } from "@effect/vitest";
import { Context, Data, Effect, Exit, Metric, Schema } from "effect";

import { idOf } from "../src/ecs/component.ts";
import type { Spawned } from "../src/index.ts";
import {
  Action,
  App,
  Commands,
  Component,
  Driver,
  Events,
  Field,
  Plugin,
  Query,
  Random,
  Resource,
  System,
  Time,
  World,
} from "../src/index.ts";
import { TickScheduler } from "../src/internal/tickScheduler.ts";
import type { ReadingWorld } from "../src/Services.ts";
import { thrown } from "./checks.ts";
import { placedIn } from "./placed.ts";

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

const Moving = Query.all(Position, Velocity).pipe(
  Query.writes(Position, Velocity),
  Query.without(Stunned)
);

/** What moves, read from outside the game. */
const Movers = Query.all(Position, Velocity).pipe(Query.without(Stunned));

const Movement = System.tick("Movement", function* () {
  const moving = yield* Moving;
  const { delta } = yield* Time;
  moving.each((pos, vel) => {
    pos.x += vel.x * delta;
    pos.y += vel.y * delta;
  });
});

/**
 * Builds an app, and hands it to `use` with its world, as `app.read(World)`
 * gives it.
 */
const withApp = <T extends Pick<App.Any, "read">, A, E2 = never>(
  make: Effect.Effect<T, never>,
  use: (app: T, world: ReadingWorld) => Effect.Effect<A, E2>
) =>
  Effect.flatMap(make, (app) =>
    Effect.flatMap(app.read(World), (world) => use(app, world))
  );

describe("systems", () => {
  it.effect("run with yieldable queries and game time", () =>
    Effect.gen(function* () {
      const spawned: Spawned[] = [];
      const Seed = Plugin.make("rt/Seed", {
        setup: Effect.gen(function* () {
          const commands = yield* Commands.spawns(Position, Velocity, Stunned);
          spawned.push(
            commands.spawn(
              Position.of({ x: 0, y: 0 }),
              Velocity.of({ x: 2, y: 4 })
            ),
            commands.spawn(
              Position.of({ x: 0, y: 0 }),
              Velocity.of({ x: 2, y: 4 }),
              Stunned
            )
          );
        }),
      });
      const game = App.define({ plugins: [Seed], systems: [Movement] });
      yield* withApp(App.make(game), (app, world) =>
        Effect.gen(function* () {
          const [a, b] = spawned.map((id) => placedIn(world, id));
          assert(a !== undefined && b !== undefined);
          yield* app.tick(0.5);
          yield* app.tick(0.5);
          expect(world.get(a, Position)).toEqual({ x: 2, y: 4 });
          expect(world.get(b, Position)).toEqual({ x: 0, y: 0 });
          expect(app.time).toEqual({ delta: 0.5, elapsed: 1, tick: 2 });
        })
      );
    })
  );

  it.effect("are ordered by stage, then by the order they are listed", () =>
    Effect.gen(function* () {
      const log: string[] = [];
      const sys = (name: string) =>
        System.tick(name, function* () {
          yield* Effect.sync(() => log.push(name));
        });
      const systems = [
        sys("render").pipe(System.inStage("postUpdate")),
        sys("b"),
        sys("a"),
        sys("input").pipe(System.inStage("preUpdate")),
        sys("c"),
      ] as const;
      yield* withApp(App.make(App.define({ systems })), (app) =>
        Effect.gen(function* () {
          expect(app.systemOrder).toEqual(["input", "b", "a", "c", "render"]);
          yield* app.tick(1);
          expect(log).toEqual(["input", "b", "a", "c", "render"]);
        })
      );
      expect(() => System.order([sys("x"), sys("x")])).toThrow(
        'Duplicate system name "x"'
      );
    })
  );

  it.effect(
    "see each other's commands as soon as the earlier system finishes",
    () =>
      Effect.gen(function* () {
        const Spawner = System.tick("Spawner", function* () {
          const commands = yield* Commands.spawns(Position, Lifetime);
          const { tick } = yield* Time;
          if (tick === 1) {
            commands.spawn(
              Position.of({ x: 0, y: 0 }),
              Lifetime.of({ seconds: 1 })
            );
          }
        });
        const counts: number[] = [];
        const Reaper = System.tick("Reaper", function* () {
          const commands = yield* Commands;
          const { delta } = yield* Time;
          const mortal = yield* Query.all(Lifetime).pipe(
            Query.writes(Lifetime)
          );
          counts.push(mortal.count());
          mortal.each((life, entity) => {
            life.seconds -= delta;
            // Despawning directly here would throw; the command is applied after the loop.
            if (life.seconds <= 0) {
              commands.despawn(entity);
            }
          });
        });

        yield* withApp(
          App.make(App.define({ systems: [Spawner, Reaper] })),
          (app, world) =>
            Effect.gen(function* () {
              yield* app.tick(0.5);
              expect(world.entityCount).toBe(1);
              yield* app.tick(0.5);
              expect(world.entityCount).toBe(0);
              yield* app.tick(0.5);
              expect(counts).toEqual([1, 1, 0]);
            })
        );
      })
  );

  it.effect(
    "read and write sparse components as query data, with either loop style",
    () =>
      Effect.gen(function* () {
        const Health = Component.define("rt/Health", { hp: Field.f32 });
        const Burning = Component.define(
          "rt/Burning",
          { seconds: Field.f32, dps: Field.f32 },
          { storage: "sparse" }
        );
        const OnFire = Query.all(Health, Burning).pipe(
          Query.writes(Health, Burning)
        );

        const Burn = System.tick("Burn", function* () {
          const onFire = yield* OnFire;
          const { delta } = yield* Time;
          onFire.each((health, burning) => {
            health.hp -= burning.dps * delta;
          });
        });
        const Extinguish = System.tick("Extinguish", function* () {
          const onFire = yield* OnFire;
          const commands = yield* Commands;
          const { delta } = yield* Time;
          onFire.eachChunk((start, end, _health, burning, entities) => {
            const { seconds } = burning.columns;
            for (let i = start; i < end; i++) {
              const row = burning.indexOf(entities[i]!);
              seconds[row]! -= delta;
              // Removing a sparse component is cheap: the entity stays in its table.
              if (seconds[row]! <= 0) {
                commands.remove(entities[i]!, Burning);
              }
            }
          });
        });

        const spawned: Spawned[] = [];
        const Seed = Plugin.make("rt/Seed", {
          setup: Effect.gen(function* () {
            const commands = yield* Commands.spawns(Health, Burning);
            spawned.push(
              commands.spawn(
                Health.of({ hp: 100 }),
                Burning.of({ seconds: 2, dps: 10 })
              ),
              commands.spawn(Health.of({ hp: 100 }))
            );
          }),
        });
        const game = App.define({
          plugins: [Seed],
          systems: [Burn, Extinguish],
        });
        yield* withApp(App.make(game), (app, world) =>
          Effect.gen(function* () {
            const [torch, rock] = spawned.map((id) => placedIn(world, id));
            assert(torch !== undefined && rock !== undefined);
            for (let i = 0; i < 4; i++) {
              yield* app.tick(1);
            }
            expect(world.get(torch, Health)).toEqual({ hp: 80 });
            expect(world.get(rock, Health)).toEqual({ hp: 100 });
            expect(world.has(torch, Burning)).toBe(false);
          })
        );
      })
  );

  it.effect("read resources with defaults that a layer can override", () =>
    Effect.gen(function* () {
      const Gravity = Resource.make("rt/Gravity", { defaultValue: () => 9.81 });
      const seen: number[] = [];
      const ReadGravity = System.tick("ReadGravity", function* () {
        seen.push(yield* Gravity);
      });
      yield* withApp(App.make(App.define({ systems: [ReadGravity] })), (app) =>
        app.tick(1)
      );
      yield* withApp(
        App.make(App.define({ systems: [ReadGravity] })).pipe(
          Effect.provide(Resource.layer(Gravity, 1.62))
        ),
        (app) => app.tick(1)
      );
      expect(seen).toEqual([9.81, 1.62]);
    })
  );

  it.effect(
    "read a resource's value as read-only, so that no app changes another's",
    () =>
      Effect.gen(function* () {
        const Config = Resource.make("rt/Config", {
          defaultValue: () => ({ difficulty: 1, levels: [{ name: "start" }] }),
        });
        const Harden = System.tick("rt/Harden", function* () {
          const config = yield* Config;
          // @ts-expect-error: a resource's value is read-only.
          config.difficulty = 2;
        });
        const Rename = System.tick("rt/Rename", function* () {
          const config = yield* Config;
          // @ts-expect-error: all the way down.
          config.levels[0]!.name = "end";
        });
        for (const system of [Harden, Rename]) {
          yield* withApp(App.make(App.define({ systems: [system] })), (app) =>
            Effect.gen(function* () {
              expect(yield* thrown(app.tick(1))).toThrow(TypeError);
            })
          );
        }
        const seen: unknown[] = [];
        const Read = System.tick("rt/Read", function* () {
          seen.push(yield* Config);
        });
        yield* withApp(App.make(App.define({ systems: [Read] })), (app) =>
          app.tick(1)
        );
        expect(seen).toEqual([{ difficulty: 1, levels: [{ name: "start" }] }]);
        // A layer's value is frozen too.
        const given = { difficulty: 3, levels: [] };
        yield* withApp(
          App.make(App.define({ systems: [Harden] })).pipe(
            Effect.provide(Resource.layer(Config, given))
          ),
          (app) =>
            Effect.gen(function* () {
              expect(yield* thrown(app.tick(1))).toThrow(TypeError);
            })
        );
        expect(given.difficulty).toBe(3);
      })
  );

  it.effect(
    "get their services the usual Effect way in the frame, and a missing one does not compile",
    () =>
      Effect.gen(function* () {
        class Audio extends Context.Service<
          Audio,
          { readonly play: (sound: string) => void }
        >()("rt/Audio") {}
        const played: string[] = [];
        System.tick(
          "rt/TickBeep",
          // @ts-expect-error a tick requires no service of the game's own
          function* () {
            (yield* Audio).play("beep");
          }
        );
        const Beep = System.frame("Beep", function* () {
          const audio = yield* Audio;
          const things = yield* Query.all(Position);
          audio.play(`beep x${things.count()}`);
        });
        const Seed = Plugin.make("rt/Seed", {
          setup: Effect.gen(function* () {
            (yield* Commands.spawns(Position)).spawn(
              Position.of({ x: 1, y: 1 })
            );
          }),
        });
        const make = App.make(
          App.define({ plugins: [Seed], systems: [Beep] })
        ).pipe(
          Effect.provideService(Audio, {
            play: (sound) => void played.push(sound),
          })
        );
        yield* withApp(make, (app) => app.frame());
        expect(played).toEqual(["beep x1"]);

        // Forgetting the layer leaves `Audio` as an unmet requirement.
        expect(
          yield* thrown(
            withApp(
              // @ts-expect-error Audio is not provided
              App.make(App.define({ systems: [Beep] })),
              (app) => app.frame()
            )
          )
        ).toThrow(/Service not found: .*Audio/);
      })
  );

  it.effect(
    "surface typed failures through tickExit, and tick() throws them",
    () =>
      Effect.gen(function* () {
        class OutOfBounds extends Data.TaggedError("OutOfBounds")<{
          readonly x: number;
        }> {}
        const Bounds = System.tick("Bounds", function* () {
          const things = yield* Query.all(Position);
          let worst = 0;
          things.each((pos) => {
            worst = Math.max(worst, pos.x);
          });
          if (worst > 100) {
            return yield* new OutOfBounds({ x: worst });
          }
        });
        const Place = Action.define(
          "rt/Place",
          Schema.Struct({ x: Schema.Number })
        );
        const place = Action.handler(Place, function* ({ x }) {
          (yield* Commands.spawns(Position)).spawn(Position.of({ x, y: 0 }));
        });
        const game = App.define({ systems: [Bounds], handlers: [place] });
        yield* withApp(App.make(game), (app) =>
          Effect.gen(function* () {
            yield* app.dispatch(Place, { x: 5 });
            expect(Exit.isSuccess(yield* Effect.exit(app.tick(1)))).toBe(true);
            yield* app.dispatch(Place, { x: 500 });
            const exit = yield* Effect.exit(app.tick(1));
            expect(Exit.isFailure(exit)).toBe(true);
            expect(yield* thrown(app.tick(1))).toThrow(OutOfBounds);
          })
        );
      })
  );

  it.effect("must finish within the tick", () =>
    Effect.gen(function* () {
      const Lazy = System.tick("Lazy", function* () {
        yield* Effect.sleep("1 second");
      });
      yield* withApp(App.make(App.define({ systems: [Lazy] })), (app) =>
        Effect.gen(function* () {
          // The message says where work that takes longer goes instead.
          expect(yield* thrown(app.tick(1))).toThrow(
            /"Lazy" did not finish within the tick\. Systems must be synchronous: what takes longer than a tick keeps its place in the world/
          );
          // The app is still usable afterwards.
          expect(yield* thrown(app.tick(1))).toThrow(/did not finish/);
        })
      );
    })
  );
});

describe("the built-in services", () => {
  it("are keyed under arcadekit/, each with its own key", () => {
    // A key is a service's identity: two services with one key silently
    // become one, and a game's own "World" must not collide with these.
    const keys = [World, Time, Commands, Events, Random, Action.Actions].map(
      (service) => service.key
    );
    expect(keys).toEqual([
      "arcadekit/World",
      "arcadekit/Time",
      "arcadekit/Commands",
      "arcadekit/Events",
      "arcadekit/Random",
      "arcadekit/Actions",
    ]);
  });

  it.effect("leave a game free to define a resource called World", () =>
    Effect.gen(function* () {
      const GameWorld = Resource.make("World", {
        defaultValue: () => ({ size: 0 }),
      });
      const sizes: number[] = [];
      const Probe = System.tick("Probe", function* () {
        const world = yield* World;
        const mine = yield* GameWorld;
        sizes.push(mine.size);
        (yield* Commands.spawns(Lifetime)).spawn(
          Lifetime.of({ seconds: mine.size + world.entityCount })
        );
      });
      yield* withApp(
        App.make(App.define({ systems: [Probe] })).pipe(
          Effect.provide(Resource.layer(GameWorld, { size: 7 }))
        ),
        (app, world) =>
          Effect.gen(function* () {
            yield* app.tick(1);
            expect(world.entityCount).toBe(1);
            expect(sizes).toEqual([7]);
          })
      );
    })
  );
});

describe("a fiber the game starts", () => {
  /** A fiber that never ends, left behind by whoever starts it. */
  const leave = Effect.forkDetach(Effect.never);
  const Ping = Action.define("rt/Ping", Schema.Struct({}));

  it.effect(
    "may be a child of the system that starts it, ended with the tick",
    () =>
      Effect.gen(function* () {
        let ran = 0;
        const Busy = System.tick("Busy", function* () {
          ran++;
          // A child of the tick's fiber, interrupted when the tick ends.
          yield* Effect.forkChild(Effect.never);
        });
        yield* withApp(App.make(App.define({ systems: [Busy] })), (app) =>
          Effect.gen(function* () {
            yield* app.tick(1);
            yield* app.tick(1);
            expect(ran).toBe(2);
          })
        );
      })
  );

  it.effect(
    "is refused when it outlives the tick, the handler, the frame or the setup that started it",
    () =>
      Effect.gen(function* () {
        const Leaky = System.tick("Leaky", function* () {
          yield* leave;
        });
        yield* withApp(App.make(App.define({ systems: [Leaky] })), (app) =>
          Effect.gen(function* () {
            expect(yield* thrown(app.tick(1))).toThrow(
              /Tick 1 left a fiber running \(started while "Leaky" ran\), with Effect\.forkDetach.*keep work that takes longer than a tick in the world/
            );
          })
        );

        const ping = Action.handler(Ping, function* () {
          (yield* Commands.spawns(Lifetime)).spawn(Lifetime.of({ seconds: 1 }));
          yield* leave;
        });
        yield* withApp(
          App.make(App.define({ handlers: [ping] })),
          (app, world) =>
            Effect.gen(function* () {
              expect(yield* thrown(app.dispatch(Ping, {}))).toThrow(
                /The handler for "rt\/Ping" left a fiber running/
              );
              // Its writes are undone, as a refusal's are.
              expect(world.entityCount).toBe(0);
            })
        );

        const Look = System.frame("Look", function* () {
          yield* leave;
        });
        yield* withApp(App.make(App.define({ systems: [Look] })), (app) =>
          Effect.gen(function* () {
            expect(yield* thrown(app.frame())).toThrow(
              /The frame left a fiber running \(started while "Look" ran\)/
            );
          })
        );

        const Setup = Plugin.make("rt/Setup", { setup: leave });
        expect(
          yield* thrown(
            withApp(App.make(App.define({ plugins: [Setup] })), () =>
              Effect.succeed(0)
            )
          )
        ).toThrow(/The setup of plugin "rt\/Setup" left a fiber running/);
      })
  );

  it.effect("is still counted by the fiber metrics a game provides", () =>
    Effect.gen(function* () {
      let started = 0;
      const Busy = System.tick("Busy", function* () {
        yield* Effect.forkChild(Effect.void);
        yield* Effect.forkChild(Effect.void);
      });
      yield* withApp(
        App.make(App.define({ systems: [Busy] })).pipe(
          Effect.provideService(Metric.FiberRuntimeMetrics, {
            recordFiberStart: () => void started++,
            recordFiberEnd: () => undefined,
          })
        ),
        (app) =>
          Effect.gen(function* () {
            started = 0;
            yield* app.tick(1);
            // The tick's own fiber and the two the system forked.
            expect(started).toBe(3);
          })
      );
    })
  );
});

describe("the tick scheduler", () => {
  // 10,000 flatMaps is far past Effect's default budget of 2048 operations.
  const busy = Effect.gen(function* () {
    let total = 0;
    for (let i = 0; i < 10_000; i++) {
      yield* Effect.sync(() => void (total += 1));
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
    expect(exit).toEqual(Exit.succeed(10_000));
  });

  it("never pauses a fiber mid-tick", () => {
    const fiber = Effect.runFork(busy, { scheduler: new TickScheduler() });
    expect(fiber.pollUnsafe()).toEqual(Exit.succeed(10_000));
  });

  it.effect("lets a heavy system finish inside its tick", () =>
    Effect.gen(function* () {
      let total = 0;
      const Heavy = System.tick("Heavy", function* () {
        total = yield* busy;
      });
      yield* withApp(App.make(App.define({ systems: [Heavy] })), (app) =>
        Effect.gen(function* () {
          yield* app.tick(1);
          expect(total).toBe(10_000);
        })
      );
    })
  );

  it("only resumes yielded fibers when the tick flushes", async () => {
    const scheduler = new TickScheduler();
    const log: string[] = [];
    Effect.runFork(
      Effect.gen(function* () {
        log.push("start");
        yield* Effect.yieldNow;
        log.push("after yieldNow");
      }),
      { scheduler }
    );
    expect(log).toEqual(["start"]);
    expect(scheduler.dispatcher.pending).toBe(1);
    // Give timers and microtasks every chance to run it behind our back.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(log).toEqual(["start"]);
    scheduler.dispatcher.flush();
    expect(log).toEqual(["start", "after yieldNow"]);
    expect(scheduler.dispatcher.pending).toBe(0);
  });

  it("stops a fiber that spins on yieldNow instead of hanging the tick", () => {
    const scheduler = new TickScheduler();
    scheduler.dispatcher.maxRounds = 50;
    Effect.runFork(Effect.forever(Effect.yieldNow), { scheduler });
    expect(() => scheduler.dispatcher.flush()).toThrow(
      /still busy after 50 rounds/
    );
  });
});

describe("determinism", () => {
  it.effect("replays identically from the same inputs", () =>
    Effect.gen(function* () {
      const run = Effect.fnUntraced(function* () {
        const trace: string[] = [];
        const Bounce = System.tick("Bounce", function* () {
          const moving = yield* Moving;
          moving.each((pos, vel) => {
            if (pos.x > 10 || pos.x < 0) {
              vel.x = -vel.x;
            }
          });
        });
        // Spawns one more every sixth tick, twenty in all.
        const Spawner = System.tick("Spawner", function* () {
          const { tick } = yield* Time;
          const i = tick / 6 - 1;
          if (Number.isInteger(i) && i < 20) {
            (yield* Commands.spawns(Position, Velocity)).spawn(
              Position.of({ x: 5, y: i }),
              Velocity.of({ x: i, y: 0 })
            );
          }
        });
        const Seed = Plugin.make("rt/Seed", {
          setup: Effect.gen(function* () {
            const commands = yield* Commands.spawns(Position, Velocity);
            for (let i = 0; i < 50; i++) {
              commands.spawn(
                Position.of({ x: i % 10, y: 0 }),
                Velocity.of({ x: (i % 7) - 3, y: 0 })
              );
            }
          }),
        });
        yield* withApp(
          App.make(
            App.define({
              plugins: [Seed],
              systems: [Movement, Bounce, Spawner],
            })
          ),
          (app, world) =>
            Effect.gen(function* () {
              const step = Driver.fixedStep(app, {
                hz: 60,
                maxStepsPerCall: 10_000,
              });
              yield* step(5);
              (yield* app.read(Movers)).each((pos, vel, entity) => {
                trace.push(`${idOf(entity)}:${pos.x},${pos.y},${vel.x}`);
              });
              trace.push(
                `ticks=${app.time.tick} entities=${world.entityCount}`
              );
            })
        );
        return trace;
      });
      const first = yield* run();
      expect(first).toHaveLength(71);
      expect(yield* run()).toEqual(first);
    })
  );
});

describe("the fixed-step driver", () => {
  it.effect(
    "runs exactly hz ticks per second of input, however the time is sliced",
    () =>
      withApp(App.make(App.define({ systems: [] })), (app) =>
        Effect.gen(function* () {
          const step = Driver.fixedStep(app, {
            hz: 60,
            maxStepsPerCall: 1000,
          });
          expect(yield* step(1)).toBe(60);
          expect(yield* step(1)).toBe(60);
          for (let i = 0; i < 1000; i++) {
            yield* step(0.001);
          }
          expect(app.time.tick).toBe(180);
          expect(yield* step(0.01)).toBe(0);
          expect(yield* step(0.01)).toBe(1);
        })
      )
  );

  it.effect("drops the backlog after a stall instead of spiralling", () =>
    withApp(App.make(App.define({ systems: [] })), (app) =>
      Effect.gen(function* () {
        const step = Driver.fixedStep(app, { hz: 60 });
        expect(yield* step(10)).toBe(5);
        expect(yield* step(1 / 60)).toBe(1);
      })
    )
  );
});
