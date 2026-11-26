import { assert, describe, expect, it } from "@effect/vitest";
import { Context, Data, Effect, Exit, Layer, Schema } from "effect";

import {
  Action,
  App,
  Commands,
  Component,
  EntityId,
  Event,
  Field,
  Plugin,
  Query,
  Resource,
  System,
  Time,
  World,
} from "../src/index.ts";
import type { Entity } from "../src/index.ts";
import { thrown } from "./checks.ts";

const Position = Component.define("pl/Position", {
  x: Field.f32,
  y: Field.f32,
});
const Velocity = Component.define("pl/Velocity", {
  x: Field.f32,
  y: Field.f32,
});
const Health = Component.define("pl/Health", { hp: Field.i32 });

const Bumped = Event.define("pl/Bumped", Schema.Struct({ entity: EntityId }));

/** Builds an app, hands it to `use`, then closes it. */
const withApp = <
  A extends { readonly close: Effect.Effect<void> },
  E,
  T,
  E2 = never,
>(
  make: Effect.Effect<A, E>,
  use: (app: A) => Effect.Effect<T, E2>
) => Effect.acquireUseRelease(make, use, (app) => app.close);

// --- a "physics" plugin: a resource, two systems, some setup -------------------

const Bounds = Resource.make<{
  readonly width: number;
  readonly clamp: (x: number) => number;
}>("pl/Bounds", {
  defaultValue: () => ({ width: 100, clamp: (x) => Math.min(x, 100) }),
});

const Movement = System.tick("Movement", function* () {
  const moving = yield* Query.all(Position, Velocity).pipe(
    Query.writes(Position)
  );
  const { delta } = yield* Time;
  moving.each((pos, vel) => {
    pos.x += vel.x * delta;
  });
});

const Walls = System.tick("Walls", function* () {
  const { clamp, width } = yield* Bounds;
  const bumped = yield* Bumped.emits;
  const moving = yield* Query.all(Position, Velocity).pipe(
    Query.writes(Position, Velocity)
  );
  moving.each((pos, vel, entity) => {
    if (pos.x > width) {
      pos.x = clamp(pos.x);
      vel.x = -vel.x;
      bumped.emit({ entity });
    }
  });
});

const Physics = Plugin.make("Physics", {
  systems: [Movement, Walls],
  // Written inline, with a function inside, on purpose: this shape is what
  // tripped up type inference in an earlier design.
  layer: Resource.layer(Bounds, { width: 10, clamp: (x) => Math.min(x, 10) }),
  setup: Effect.gen(function* () {
    const commands = yield* Commands.spawns(Position, Velocity);
    commands.spawn(Position.of({ x: 9, y: 0 }), Velocity.of({ x: 2, y: 0 }));
  }),
});

// --- a "combat" plugin that depends on physics ---------------------------------

class Fragile extends Data.TaggedError("Fragile")<{
  readonly entity: Entity;
}> {}
class NothingToHeal extends Schema.TaggedError<NothingToHeal>()(
  "NothingToHeal",
  {}
) {}

const Heal = Action.define("Heal", Schema.Struct({ amount: Schema.Number }), {
  error: NothingToHeal,
});

const heal = Action.handler(Heal, function* ({ amount }) {
  const wounded = yield* Query.all(Health).pipe(Query.writes(Health));
  if (wounded.count() === 0) {
    return yield* NothingToHeal.make({});
  }
  let total = 0;
  wounded.each((health) => {
    health.hp += amount;
    total += health.hp;
  });
  return total;
});

const BumpDamage = System.tick("BumpDamage", function* () {
  const world = yield* World.writes(Health);
  for (const { entity } of (yield* Bumped).read()) {
    const health = world.get(entity, Health);
    if (health === undefined) {
      continue;
    }
    if (health.hp <= 1) {
      return yield* new Fragile({ entity });
    }
    world.set(entity, Health, { hp: health.hp - 1 });
  }
});

const Combat = Plugin.make("Combat", {
  plugins: [Physics],
  systems: [BumpDamage],
  handlers: [heal],
});

/** Gives everything that has a position some health. */
const Wound = Action.define("pl/Wound", Schema.Struct({ hp: Schema.Int }));
const wound = Action.handler(Wound, function* ({ hp }) {
  const commands = yield* Commands.spawns(Health);
  for (const entity of (yield* Query.all(Position)).entities()) {
    commands.add(entity, Health.of({ hp }));
  }
});

describe("plugins", () => {
  it.effect(
    "bundle systems, handlers, resources and setup into one value",
    () =>
      Effect.gen(function* () {
        const app = yield* App.make(
          App.define({ plugins: [Combat], handlers: [wound] })
        );
        expect(app.plugins).toEqual(["Physics", "Combat"]);
        expect(app.systemOrder).toEqual(["Movement", "Walls", "BumpDamage"]);
        // Physics' setup spawned the ball.
        const world = yield* app.read(World);
        expect(world.entityCount).toBe(1);
        const [ball] = (yield* app.read(Query.all(Position))).entities();
        expect(app.dispatch(Wound, { hp: 3 })).toEqual(Exit.void);

        app.tick(1); // 9 -> 11, bounces off the wall at 10, loses 1 hp
        expect(world.get(ball!, Position)!.x).toBe(10);
        expect(world.get(ball!, Health)).toEqual({ hp: 2 });

        // The handler came with the plugin, and dispatch is typed from it.
        const healed: Exit.Exit<number, NothingToHeal | Action.InvalidPayload> =
          app.dispatch(Heal, {
            amount: 5,
          });
        expect(healed).toEqual(Exit.succeed(7));

        // So is the tick's failure type.
        const exit: Exit.Exit<void, Fragile> = app.tickExit(1);
        expect(Exit.isSuccess(exit)).toBe(true);
      })
  );

  it.effect(
    "can be combined with systems and handlers the app defines itself",
    () =>
      Effect.gen(function* () {
        const Ping = Action.define("Ping", Schema.Struct({}));
        const ping = Action.handler(Ping, function* () {
          return "pong";
        });
        const seen: number[] = [];
        const Watch = System.tick("Watch", function* () {
          seen.push((yield* Bumped).read().length);
        });
        yield* withApp(
          App.make(
            App.define({
              plugins: [Physics],
              systems: [Watch],
              handlers: [ping],
            })
          ),
          (app) =>
            Effect.gen(function* () {
              app.tick(1);
              expect(seen).toEqual([1]);
              expect(app.dispatch(Ping, {})).toEqual(Exit.succeed("pong"));
              // @ts-expect-error Heal belongs to Combat, which this app did not install
              expect(() => app.dispatch(Heal, { amount: 1 })).toThrow(
                /No handler/
              );
            })
        );
      })
  );

  it.effect(
    "install a shared dependency once, before everything that needs it",
    () =>
      Effect.gen(function* () {
        let built = 0;
        let released = 0;
        const order: string[] = [];
        class Clock extends Context.Service<Clock, { readonly id: number }>()(
          "pl/Clock"
        ) {}
        const Core = Plugin.make("Core", {
          systems: [
            System.frame("CoreSystem", function* () {
              order.push("frame:Core");
            }),
          ],
          layer: Layer.effect(
            Clock,
            Effect.acquireRelease(
              Effect.sync(() => ({ id: ++built })),
              () => Effect.sync(() => void released++)
            )
          ),
          setup: Effect.sync(() => void order.push("setup:Core")),
        });
        const own = <const Name extends string>(name: Name) => ({
          systems: [
            System.frame(`${name}System`, function* () {
              order.push(`frame:${name}:${(yield* Clock).id}`);
            }),
          ] as const,
          setup: Effect.sync(() => void order.push(`setup:${name}`)),
        });
        const Left = Plugin.make("Left", { plugins: [Core], ...own("Left") });
        const Right = Plugin.make("Right", {
          plugins: [Core],
          ...own("Right"),
        });
        const Top = Plugin.make("Top", {
          plugins: [Left, Right],
          ...own("Top"),
        });

        yield* withApp(App.make(App.define({ plugins: [Top, Core] })), (app) =>
          Effect.gen(function* () {
            expect(app.plugins).toEqual(["Core", "Left", "Right", "Top"]);
            expect(built).toBe(1);
            expect(order).toEqual([
              "setup:Core",
              "setup:Left",
              "setup:Right",
              "setup:Top",
            ]);
            order.length = 0;
            app.tick(1);
            app.frame();
            expect(order).toEqual([
              "frame:Core",
              "frame:Left:1",
              "frame:Right:1",
              "frame:Top:1",
            ]);
            expect(released).toBe(0);
          })
        );
        // The plugin's resource is released with the app.
        expect(released).toBe(1);
      })
  );

  it.effect(
    "let a plugin's layer use its dependencies and read the built-in services while it builds",
    () =>
      Effect.gen(function* () {
        // Bounds is 100 unless Physics, which Arena lists, overrides it.
        class Arena extends Context.Service<
          Arena,
          { readonly width: number; readonly entities: number }
        >()("pl/Arena") {}
        const ArenaPlugin = Plugin.make("Arena", {
          plugins: [Physics],
          layer: Layer.effect(
            Arena,
            Effect.gen(function* () {
              const { width } = yield* Bounds; // as the Physics plugin sets it
              const world = yield* World; // built in
              return { width, entities: world.entityCount };
            })
          ),
          setup: Effect.gen(function* () {
            const { width } = yield* Bounds;
            const commands = yield* Commands.spawns(Position);
            commands.spawn(Position.of({ x: width, y: 0 }));
          }),
        });
        const seen: string[] = [];
        const Look = System.frame("Look", function* () {
          const arena = yield* Arena;
          const walls = yield* Query.all(Position).pipe(
            Query.without(Velocity)
          );
          walls.each((wall) => {
            seen.push(
              `wall ${wall.x} of ${arena.width}, ${arena.entities} built`
            );
          });
        });
        yield* withApp(
          App.make(App.define({ plugins: [ArenaPlugin], systems: [Look] })),
          (app) =>
            Effect.gen(function* () {
              app.tick(1);
              app.frame();
              expect(seen).toEqual(["wall 10 of 10, 0 built"]);
            })
        );
      })
  );

  it.effect(
    "refuse a layer that changes the game, since loading a save builds it again",
    () =>
      Effect.gen(function* () {
        class Arena extends Context.Service<
          Arena,
          { readonly width: number }
        >()("pl/SpawningArena") {}
        Plugin.make("pl/SpawningArena", {
          // @ts-expect-error a layer spawns nothing; a setup does
          layer: Layer.effect(
            Arena,
            Effect.gen(function* () {
              const commands = yield* Commands.spawns(Position);
              commands.spawn(Position.of({ x: 10, y: 0 }));
              return { width: 10 };
            })
          ),
        });
        Plugin.make("pl/WritingArena", {
          // @ts-expect-error a layer writes no component
          layer: Layer.effectDiscard(
            Effect.gen(function* () {
              const all = yield* Query.all(Position).pipe(
                Query.writes(Position)
              );
              all.each((position) => {
                position.x = 0;
              });
            })
          ),
        });

        const Walls = Plugin.make("pl/Walls", {
          setup: Effect.gen(function* () {
            const commands = yield* Commands.spawns(Position);
            commands.spawn(Position.of({ x: 10, y: 0 }));
          }),
        });
        const game = App.define({ plugins: [Walls] });
        const entities = Effect.map(
          Effect.service(World),
          (w) => w.entityCount
        );
        const save = yield* withApp(App.make(game), (app) =>
          Effect.gen(function* () {
            app.tick(1);
            expect(yield* app.read(entities)).toBe(1);
            return app.save();
          })
        );
        assert(Exit.isSuccess(save));
        yield* withApp(App.make(game, { save: save.value }), (app) =>
          Effect.gen(function* () {
            expect(yield* app.read(entities)).toBe(1);
          })
        );
      })
  );

  it.effect("leave unmet needs as ordinary Effect requirements", () =>
    Effect.gen(function* () {
      class Audio extends Context.Service<
        Audio,
        { readonly play: (sound: string) => void }
      >()("pl/Audio") {}
      const played: string[] = [];
      const Sfx = Plugin.make("Sfx", {
        plugins: [Physics],
        systems: [
          System.frame("BumpSound", function* () {
            const audio = yield* Audio;
            for (const _ of (yield* Bumped).read()) {
              audio.play("boing");
            }
          }),
        ],
      });
      const provided = App.make(App.define({ plugins: [Sfx] })).pipe(
        Effect.provideService(Audio, {
          play: (sound) => void played.push(sound),
        })
      );
      yield* withApp(provided, (app) =>
        Effect.gen(function* () {
          app.tick(1);
          app.frame();
        })
      );
      expect(played).toEqual(["boing"]);

      expect(
        yield* thrown(
          withApp(
            // @ts-expect-error nothing provides Audio
            App.make(App.define({ plugins: [Sfx] })),
            (app) =>
              Effect.gen(function* () {
                app.tick(1);
                app.frame();
              })
          )
        )
      ).toThrow(/Service not found: .*Audio/);
    })
  );

  it.effect("require a layer's dependencies to be declared", () =>
    Effect.gen(function* () {
      class Units extends Context.Service<Units, { readonly scale: number }>()(
        "pl/Units"
      ) {}
      const Metric = Plugin.make("Metric", {
        layer: Layer.succeed(Units, { scale: 10 }),
      });
      class Speed extends Context.Service<Speed, { readonly limit: number }>()(
        "pl/Speed"
      ) {}
      const speedFromUnits = Layer.effect(
        Speed,
        Effect.map(Effect.service(Units), ({ scale }) => ({ limit: scale * 2 }))
      );
      const limits: number[] = [];
      const ReadSpeed = System.frame("ReadSpeed", function* () {
        limits.push((yield* Speed).limit);
      });

      const Declared = Plugin.make("Declared", {
        plugins: [Metric],
        layer: speedFromUnits,
        systems: [ReadSpeed],
      });
      yield* withApp(App.make(App.define({ plugins: [Declared] })), (app) =>
        Effect.sync(() => app.frame())
      );
      expect(limits).toEqual([20]);

      // Installing Metric alongside is not enough: the layer is built from
      // what the plugin itself declares, so the missing service stays a
      // requirement and the app does not compile until something provides it.
      const Undeclared = Plugin.make("Undeclared", {
        layer: speedFromUnits,
        systems: [ReadSpeed],
      });
      expect(
        yield* thrown(
          withApp(
            // @ts-expect-error Units is needed by Undeclared's layer and not declared
            App.make(App.define({ plugins: [Undeclared, Metric] })),
            (app) => Effect.sync(() => app.frame())
          )
        )
      ).toThrow(/Service not found: .*Units/);
      yield* withApp(
        App.make(App.define({ plugins: [Undeclared] })).pipe(
          Effect.provideService(Units, { scale: 3 })
        ),
        (app) => Effect.sync(() => app.frame())
      );
      expect(limits).toEqual([20, 6]);
    })
  );

  it.effect(
    "refuse a service of the game's own in the tick, and take it in the frame",
    () =>
      Effect.gen(function* () {
        class Audio extends Context.Service<
          Audio,
          { readonly play: (sound: string) => void }
        >()("pl/Audio") {}
        System.tick(
          "pl/TickAudio",
          // @ts-expect-error what a service keeps is no part of the world
          function* () {
            (yield* Audio).play("boing");
          }
        );
        const Ping = Action.define("pl/Ping", Schema.Struct({}));
        Action.handler(
          Ping,
          // @ts-expect-error a handler runs as the tick does
          function* () {
            (yield* Audio).play("boing");
          }
        );
        Plugin.make("pl/LoudSetup", {
          // @ts-expect-error a setup runs as the tick does
          setup: Effect.gen(function* () {
            (yield* Audio).play("boing");
          }),
        });
        const Play = System.frame("pl/FrameAudio", function* () {
          (yield* Audio).play("boing");
        });
        const needs: Effect.Effect<App.App, never, Audio> = App.make(
          App.define({ systems: [Play] })
        );
        const played: string[] = [];
        yield* withApp(
          needs.pipe(
            Effect.provideService(Audio, {
              play: (sound) => void played.push(sound),
            })
          ),
          (app) => Effect.sync(() => app.frame())
        );
        expect(played).toEqual(["boing"]);
      })
  );

  it.effect(
    "have what a setup spawned in the world when the next plugin's setup runs",
    () =>
      Effect.gen(function* () {
        let seen = -1;
        const First = Plugin.make("pl/First", {
          setup: Effect.gen(function* () {
            (yield* Commands.spawns(Health)).spawn(Health.of({ hp: 1 }));
          }),
        });
        const Second = Plugin.make("pl/Second", {
          plugins: [First],
          setup: Effect.gen(function* () {
            seen = (yield* Query.all(Health)).entities().length;
          }),
        });
        yield* withApp(App.make(App.define({ plugins: [Second] })), () =>
          Effect.gen(function* () {
            expect(seen).toBe(1);
          })
        );
      })
  );

  it.effect(
    "fail the app with a typed error when a layer or a setup fails",
    () =>
      Effect.gen(function* () {
        class NoSaveFile extends Data.TaggedError("NoSaveFile")<{
          readonly path: string;
        }> {}
        class BadConfig extends Data.TaggedError("BadConfig")<{}> {}
        const Loader = Plugin.make("Loader", {
          setup: Effect.fail(new NoSaveFile({ path: "slot1" })),
        });
        const Config = Plugin.make("Config", {
          layer: Layer.effectDiscard(Effect.fail(new BadConfig())),
        });

        const make: Effect.Effect<unknown, NoSaveFile | BadConfig> = App.make(
          App.define({ plugins: [Loader, Config] })
        );
        expect(yield* Effect.exit(make)).toEqual(Exit.fail(new BadConfig()));
        expect(
          yield* Effect.exit(App.make(App.define({ plugins: [Loader] })))
        ).toEqual(Exit.fail(new NoSaveFile({ path: "slot1" })));

        const Slow = Plugin.make("Slow", {
          setup: Effect.sleep("1 second"),
        });
        const exit = yield* Effect.exit(
          App.make(App.define({ plugins: [Slow] }))
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(String(exit)).toMatch(
          /setup of plugin \\?"Slow\\?" did not finish synchronously/
        );
      })
  );

  it.effect(
    "take no scripts: what runs across ticks keeps its place in the world, and a system moves it",
    () =>
      Effect.gen(function* () {
        // @ts-expect-error a plugin has no scripts
        void Plugin.make("Scripted", { scripts: [] });
        const app = yield* App.make(App.define({}));
        expect("spawnScript" in app).toBe(false);
      })
  );

  it.effect("reject clashing names", () =>
    Effect.gen(function* () {
      const one = Plugin.make("Twin", {});
      const two = Plugin.make("Twin", {});
      expect(
        yield* thrown(
          App.make(
            App.define(
              // @ts-expect-error two plugins named Twin
              { plugins: [one, two] }
            )
          )
        )
      ).toThrow(/both named "Twin"/);
      const again = App.define(
        // @ts-expect-error the same plugin twice in one list, installed once
        { plugins: [one, one] }
      );
      yield* withApp(App.make(again), (app) =>
        Effect.sync(() => expect(app.plugins).toEqual(["Twin"]))
      );

      const clash = Plugin.make("Clash", { systems: [Movement] });
      App.define(
        // @ts-expect-error duplicate system name
        { plugins: [Physics, clash] }
      );
      const healAgain = Plugin.make("HealAgain", { handlers: [heal] });
      App.define(
        // @ts-expect-error duplicate handler
        { plugins: [Combat, healAgain] }
      );
    })
  );
});
