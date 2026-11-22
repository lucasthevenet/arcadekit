import { Context, Data, Effect, Exit, Layer, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

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
  System,
  Time,
  World,
} from "../src/index";
import type { Entity } from "../src/index";

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

/** Builds an app, hands it to `use`, then closes its scope. */
const withApp = <A, E, T>(
  make: Effect.Effect<A, E, Scope.Scope>,
  use: (app: A) => T
): T => Effect.runSync(Effect.scoped(Effect.map(make, use)));

// --- a "physics" plugin: a service, two systems, some setup --------------------

class Bounds extends Context.Service<
  Bounds,
  {
    readonly width: number;
    readonly clamp: (x: number) => number;
  }
>()("pl/Bounds") {}

const Movement = System.make("Movement", function* () {
  const moving = yield* Query.all(Position, Velocity).pipe(
    Query.writes(Position)
  );
  const { delta } = yield* Time;
  moving.each((pos, vel) => {
    pos.x += vel.x * delta;
  });
});

const Walls = System.make("Walls", function* () {
  const { clamp, width } = yield* Bounds;
  const bumped = yield* Bumped;
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
  layer: Layer.succeed(Bounds, { width: 10, clamp: (x) => Math.min(x, 10) }),
  setup: Effect.gen(function* () {
    const commands = yield* Commands;
    commands.spawn(Position.of({ x: 9, y: 0 }), Velocity.of({ x: 2, y: 0 }));
  }),
});

// --- a "combat" plugin that depends on physics ---------------------------------

class Fragile extends Data.TaggedError("Fragile")<{
  readonly entity: Entity;
}> {}
class NothingToHeal extends Data.TaggedError("NothingToHeal")<{}> {}

const Heal = Action.define("Heal", Schema.Struct({ amount: Schema.Number }));

const heal = Action.handler(Heal, function* ({ amount }) {
  const wounded = yield* Query.all(Health).pipe(Query.writes(Health));
  if (wounded.count() === 0) {
    return yield* new NothingToHeal();
  }
  let total = 0;
  wounded.each((health) => {
    health.hp += amount;
    total += health.hp;
  });
  return total;
});

const BumpDamage = System.make("BumpDamage", function* () {
  const world = yield* World;
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

describe("plugins", () => {
  it("bundle systems, handlers, services and setup into one value", () => {
    withApp(App.make(App.define({ plugins: [Combat] })), (app) => {
      expect(app.plugins).toEqual(["Physics", "Combat"]);
      expect(app.systemOrder).toEqual(["Movement", "Walls", "BumpDamage"]);
      // Physics' setup spawned the ball.
      expect(app.world.entityCount).toBe(1);
      const ball = app.world.view(Query.all(Position)).entities()[0];
      app.world.add(ball!, Health.of({ hp: 3 }));

      app.tick(1); // 9 -> 11, bounces off the wall at 10, loses 1 hp
      expect(app.world.get(ball!, Position)!.x).toBe(10);
      expect(app.world.get(ball!, Health)).toEqual({ hp: 2 });

      // The handler came with the plugin, and dispatch is typed from it.
      const healed: Exit.Exit<number, NothingToHeal | Action.InvalidPayload> =
        app.dispatch(Heal, {
          amount: 5,
        });
      expect(healed).toEqual(Exit.succeed(7));

      // So is the tick's failure type.
      const exit: Exit.Exit<void, Fragile> = app.tickExit(1);
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });

  it("can be combined with systems and handlers the app defines itself", () => {
    const Ping = Action.define("Ping", Schema.Struct({}));
    const ping = Action.handler(Ping, function* () {
      return "pong";
    });
    const seen: number[] = [];
    const Watch = System.make("Watch", function* () {
      seen.push((yield* Bumped).read().length);
    });
    withApp(
      App.make(
        App.define({ plugins: [Physics], systems: [Watch], handlers: [ping] })
      ),
      (app) => {
        app.tick(1);
        expect(seen).toEqual([1]);
        expect(app.dispatch(Ping, {})).toEqual(Exit.succeed("pong"));
        // @ts-expect-error Heal belongs to Combat, which this app did not install
        expect(() => app.dispatch(Heal, { amount: 1 })).toThrow(/No handler/);
      }
    );
  });

  it("install a shared dependency once, before everything that needs it", () => {
    let built = 0;
    let released = 0;
    const order: string[] = [];
    class Clock extends Context.Service<Clock, { readonly id: number }>()(
      "pl/Clock"
    ) {}
    const Core = Plugin.make("Core", {
      systems: [
        System.make("CoreSystem", function* () {
          order.push("tick:Core");
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
    type NeedsClock = Plugin.Plugin<never, never, Clock, never, never, Clock>;
    const plugin = (
      name: string,
      plugins: readonly (Plugin.Plugin<never, never, Clock> | NeedsClock)[]
    ) =>
      Plugin.make(name, {
        plugins: [...plugins],
        systems: [
          System.make(`${name}System`, function* () {
            order.push(`tick:${name}:${(yield* Clock).id}`);
          }),
        ],
        setup: Effect.sync(() => void order.push(`setup:${name}`)),
      });
    const Left = plugin("Left", [Core]);
    const Right = plugin("Right", [Core]);
    const Top = plugin("Top", [Left, Right]);

    withApp(App.make(App.define({ plugins: [Top, Core] })), (app) => {
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
      expect(order).toEqual([
        "tick:Core",
        "tick:Left:1",
        "tick:Right:1",
        "tick:Top:1",
      ]);
      expect(released).toBe(0);
    });
    // The plugin's resource is released with the app.
    expect(released).toBe(1);
  });

  it("let a plugin's layer use its dependencies and the built-in services while it builds", () => {
    class Arena extends Context.Service<
      Arena,
      { readonly wall: Entity; readonly width: number }
    >()("pl/Arena") {}
    const ArenaPlugin = Plugin.make("Arena", {
      plugins: [Physics],
      layer: Layer.effect(
        Arena,
        Effect.gen(function* () {
          const { width } = yield* Bounds; // from the Physics plugin
          const commands = yield* Commands; // built in
          const wall = commands.spawn(Position.of({ x: width, y: 0 }));
          commands.apply();
          return { wall, width };
        })
      ),
    });
    const seen: string[] = [];
    const Look = System.make("Look", function* () {
      const arena = yield* Arena;
      seen.push(
        `wall ${(yield* World).get(arena.wall, Position)!.x} of ${arena.width}`
      );
    });
    withApp(
      App.make(App.define({ plugins: [ArenaPlugin], systems: [Look] })),
      (app) => {
        app.tick(1);
        expect(seen).toEqual(["wall 10 of 10"]);
      }
    );
  });

  it("leave unmet needs as ordinary Effect requirements", () => {
    class Audio extends Context.Service<
      Audio,
      { readonly play: (sound: string) => void }
    >()("pl/Audio") {}
    const played: string[] = [];
    const Sfx = Plugin.make("Sfx", {
      plugins: [Physics],
      systems: [
        System.make("BumpSound", function* () {
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
    withApp(provided, (app) => app.tick(1));
    expect(played).toEqual(["boing"]);

    expect(() =>
      withApp(
        // @ts-expect-error nothing provides Audio
        App.make(App.define({ plugins: [Sfx] })),
        (app) => app.tick(1)
      )
    ).toThrow(/Service not found: .*Audio/);
  });

  it("require a layer's dependencies to be declared", () => {
    class Speed extends Context.Service<Speed, { readonly limit: number }>()(
      "pl/Speed"
    ) {}
    const speedFromBounds = Layer.effect(
      Speed,
      Effect.map(Effect.service(Bounds), ({ width }) => ({ limit: width * 2 }))
    );
    const limits: number[] = [];
    const ReadSpeed = System.make("ReadSpeed", function* () {
      limits.push((yield* Speed).limit);
    });

    const Declared = Plugin.make("Declared", {
      plugins: [Physics],
      layer: speedFromBounds,
      systems: [ReadSpeed],
    });
    withApp(App.make(App.define({ plugins: [Declared] })), (app) =>
      app.tick(1)
    );
    expect(limits).toEqual([20]);

    // Installing Physics alongside is not enough: the layer is built from
    // what the plugin itself declares, so the missing service stays a
    // requirement and the app does not compile until something provides it.
    const Undeclared = Plugin.make("Undeclared", {
      layer: speedFromBounds,
      systems: [ReadSpeed],
    });
    expect(() =>
      withApp(
        // @ts-expect-error Bounds is needed by Undeclared's layer and not declared
        App.make(App.define({ plugins: [Undeclared, Physics] })),
        (app) => app.tick(1)
      )
    ).toThrow(/Service not found: .*Bounds/);
    withApp(
      App.make(App.define({ plugins: [Undeclared] })).pipe(
        Effect.provideService(Bounds, {
          width: 3,
          clamp: (x) => Math.min(x, 3),
        })
      ),
      (app) => app.tick(1)
    );
    expect(limits).toEqual([20, 6]);
  });

  it("have what a setup spawned in the world when the next plugin's setup runs", () => {
    let seen = -1;
    const First = Plugin.make("pl/First", {
      setup: Effect.gen(function* () {
        (yield* Commands).spawn(Health.of({ hp: 1 }));
      }),
    });
    const Second = Plugin.make("pl/Second", {
      plugins: [First],
      setup: Effect.gen(function* () {
        seen = (yield* World).view(Query.all(Health)).entities().length;
      }),
    });
    withApp(App.make(App.define({ plugins: [Second] })), () => {
      expect(seen).toBe(1);
    });
  });

  it("fail the app with a typed error when a layer or a setup fails", () => {
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

    const make: Effect.Effect<unknown, NoSaveFile | BadConfig, Scope.Scope> =
      App.make(App.define({ plugins: [Loader, Config] }));
    expect(Effect.runSyncExit(Effect.scoped(make))).toEqual(
      Exit.fail(new BadConfig())
    );
    expect(
      Effect.runSyncExit(
        Effect.scoped(App.make(App.define({ plugins: [Loader] })))
      )
    ).toEqual(Exit.fail(new NoSaveFile({ path: "slot1" })));

    const Slow = Plugin.make("Slow", {
      setup: Effect.sleep("1 second"),
    });
    const exit = Effect.runSyncExit(
      Effect.scoped(App.make(App.define({ plugins: [Slow] })))
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toMatch(
      /setup of plugin \\?"Slow\\?" did not finish synchronously/
    );
  });

  it("take no scripts: what runs across ticks keeps its place in the world, and a system moves it", () => {
    // @ts-expect-error a plugin has no scripts
    void Plugin.make("Scripted", { scripts: [] });
    const app = Effect.runSync(Effect.scoped(App.make(App.define({}))));
    expect("spawnScript" in app).toBe(false);
  });

  it("reject clashing names", () => {
    const one = Plugin.make("Twin", {});
    const two = Plugin.make("Twin", {});
    expect(() =>
      Effect.runSync(
        Effect.scoped(App.make(App.define({ plugins: [one, two] })))
      )
    ).toThrow(/both named "Twin"/);
    // The same plugin listed twice is fine.
    withApp(App.make(App.define({ plugins: [one, one] })), (app) =>
      expect(app.plugins).toEqual(["Twin"])
    );

    const clash = Plugin.make("Clash", { systems: [Movement] });
    expect(() =>
      Effect.runSync(
        Effect.scoped(App.make(App.define({ plugins: [Physics, clash] })))
      )
    ).toThrow(/Duplicate system name "Movement"/);
    const healAgain = Plugin.make("HealAgain", { handlers: [heal] });
    expect(() =>
      Effect.runSync(
        Effect.scoped(App.make(App.define({ plugins: [Combat, healAgain] })))
      )
    ).toThrow(/Two handlers for action "Heal"/);
  });
});
