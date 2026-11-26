import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Effect,
  Random as EffectRandom,
  Exit,
  Layer,
  Schema,
} from "effect";

import { entityIndex } from "../src/ecs/component.ts";
import {
  CommandBuffer,
  World as EcsWorld,
  readSnapshot,
} from "../src/ecs/index.ts";
import type { ComponentDef } from "../src/ecs/index.ts";
import {
  Action,
  App,
  Commands,
  Component,
  Driver,
  Event,
  Events,
  Field,
  Frame,
  Plugin,
  Query,
  Random,
  Replay,
  Save,
  Singleton,
  State,
  System,
  Time,
  Timeline,
  World,
} from "../src/index.ts";
import type { Entity, Rng } from "../src/index.ts";
import { VISITS } from "../src/internal/save.ts";
import type { BuiltIn } from "../src/Services.ts";
import { thrown } from "./checks.ts";

const Ball = Component.define("fr/Ball", { x: Field.f32, vx: Field.f32 });
const Glow = Component.define(
  "fr/Glow",
  { level: Field.u8 },
  { storage: "sparse" }
);
const Score = Singleton.define(
  "fr/Score",
  { points: Field.i32 },
  { points: 0 }
);
const Phase = State.define("fr/Phase", ["playing", "paused"]);
const Balls = Query.all(Ball).pipe(Query.writes(Ball));
const Leash = Component.relation("fr/Leash", { onTargetDespawn: "remove" });
const Seen = Query.all(Ball);
const Moved = Query.all(Ball).pipe(Query.changed(Ball), Query.writes(Ball));
const Watched = Query.all(Ball).pipe(Query.changed(Ball));

/**
 * The tick's generator, which is the world's, kept by a plugin's layer as a
 * service of its own: how a frame or input system could draw from it.
 */
class Dice extends Context.Service<Dice, Rng>()("fr/Dice") {}
const Kept = Plugin.make("fr/Kept", {
  layer: Layer.effect(Dice, Effect.service(Random)),
});

const Roll = System.tick("Roll", function* () {
  const { delta } = yield* Time;
  (yield* Balls).each((ball) => {
    ball.x += ball.vx * delta;
  });
});

/** A game that begins with these balls. */
const racked = (...balls: readonly { x: number; vx: number }[]) =>
  Plugin.make("fr/Rack", {
    setup: Effect.gen(function* () {
      const commands = yield* Commands.spawns(Ball);
      for (const ball of balls) {
        commands.spawn(Ball.of(ball));
      }
    }),
  });

/** Each ball, where it is and how fast it rolls. */
const ballsOf = Effect.fnUntraced(function* (app: App.Any) {
  const found: { x: number; vx: number }[] = [];
  (yield* app.read(Seen)).each(({ x, vx }) => {
    found.push({ x, vx });
  });
  return found;
});

describe("a frozen world", () => {
  const populated = (): { world: EcsWorld; ball: Entity } => {
    const world = new EcsWorld({ seed: 1 });
    const ball = world.spawn(Ball.of({ x: 1, vx: 2 }), Glow.of({ level: 3 }));
    world.spawn(Ball.of({ x: 5, vx: 0 }), Leash.of({ target: ball }));
    world.singleton(Score).points = 7;
    return { world, ball };
  };

  it("is read as ever, and whatever would change it throws and says why", () => {
    const { ball, world } = populated();
    const commands = new CommandBuffer(world);
    const before = world.hash();
    world.freeze();
    expect(world.frozen).toBe(true);
    // Reading.
    expect(world.get(ball, Ball)).toEqual({ x: 1, vx: 2 });
    expect(world.view(Balls).count()).toBe(2);
    expect(world.view(Query.all(Ball, Glow)).single()[0].x).toBe(1);
    expect(world.singleton(Score).points).toBe(7);
    let sum = 0;
    world.view(Balls).each((row) => {
      sum += row.x;
    });
    world.view(Balls).eachChunk((start, end, rows) => {
      for (let i = start; i < end; i++) {
        sum += rows.x[i]!;
      }
    });
    world
      .view(Query.all(Ball, Leash))
      .pointingAt(Leash, ball)
      .each((row) => {
        sum += row.x;
      });
    expect(sum).toBe(17);
    // Changing.
    const bytes = new EcsWorld().snapshot();
    const changes: [string, () => unknown][] = [
      ["World.spawn()", () => world.spawn(Ball)],
      ["World.despawn()", () => world.despawn(ball)],
      ["World.add()", () => world.add(ball, Glow.of({ level: 1 }))],
      ["World.remove()", () => world.remove(ball, Glow)],
      ["World.set()", () => world.set(ball, Ball, { x: 9 })],
      ['singleton "fr/Score"', () => (world.singleton(Score).points = 1)],
      ["A spawn", () => commands.spawn(Ball)],
      ["Commands.despawn()", () => commands.despawn(ball)],
      ["Commands.add()", () => commands.add(ball, Glow)],
      ["Commands.remove()", () => commands.remove(ball, Glow)],
      ["CommandBuffer.apply()", () => commands.apply()],
      ["World.begin()", () => world.begin()],
      ["World.restore()", () => world.restore(bytes)],
      [
        'An assignment to "fr/Ball.x"',
        () =>
          world.view(Balls).each((row) => {
            row.x = 0;
          }),
      ],
      [
        'An assignment to "fr/Ball.x"',
        () =>
          world
            .view(Query.all(Ball, Leash).pipe(Query.writes(Ball)))
            .pointingAt(Leash, ball)
            .each((row) => {
              row.x = 0;
            }),
      ],
      [
        'An assignment to "fr/Ball.x"',
        () => {
          const [row] = world
            .view(Query.all(Ball, Glow).pipe(Query.writes(Ball)))
            .single();
          row.x = 0;
        },
      ],
      [
        'An assignment to "fr/Glow.level"',
        () =>
          world.view(Query.all(Glow).pipe(Query.writes(Glow))).each((glow) => {
            glow.level = 0;
          }),
      ],
    ];
    for (const [what, change] of changes) {
      expect(change, what).toThrow(/while the world is frozen/);
      expect(change, what).toThrow(what);
    }
    expect(commands.size).toBe(0);
    expect(world.entityCount).toBe(2);
    expect(world.hash()).toBe(before);

    world.thaw();
    expect(world.frozen).toBe(false);
    // The same queries write again.
    world.view(Balls).each((row) => {
      row.x += 1;
    });
    world.view(Query.all(Glow).pipe(Query.writes(Glow))).each((glow) => {
      glow.level = 9;
    });
    expect(world.get(ball, Ball)!.x).toBe(2);
    expect(world.get(ball, Glow)!.level).toBe(9);
    world.singleton(Score).points = 8;
    expect(world.hash()).not.toBe(before);
  });

  it("counts nothing as written, so a change query can read what it watches raw", () => {
    const { ball, world } = populated();
    // Thawed, a query that watches and writes Ball has no raw loop: watching
    // a Ball known only as a ComponentDef, it throws, as it would take its own
    // visit for a change.
    const widened: ComponentDef = Ball;
    const moved = world.view(
      Query.all(Ball).pipe(Query.changed(widened), Query.writes(Ball)),
      "drawer"
    );
    const other = world.view(Moved, "other");
    other.entities();
    world.freeze();
    const seen: number[] = [];
    moved.eachChunk((start, end, rows) => {
      for (let i = start; i < end; i++) {
        seen.push(rows.x[i]!);
      }
    });
    expect(seen).toEqual([1, 5]);
    // The visit was a visit, and noted nothing for anyone.
    expect(moved.count()).toBe(0);
    expect(other.count()).toBe(0);
    world.view(Balls).eachChunk(() => {});
    expect(other.count()).toBe(0);
    world.thaw();
    expect(() => moved.eachChunk(() => {})).toThrow(/watches "fr\/Ball"/);
    world.set(ball, Ball, { x: 4 });
    world.freeze();
    expect(moved.entities()).toEqual([ball]);
    world.thaw();
  });

  it("finds a draw from its random generator when it is thawed, and takes it back", () => {
    const { world } = populated();
    const before = world.hash();
    const state = Array.from(world.random.state);
    world.freeze();
    world.random.next();
    world.random.shuffle([1, 2, 3]);
    expect(() => world.thaw()).toThrow(
      /A draw from world\.random was made while the world is frozen.*frame stage's own Random/
    );
    // Thawed all the same, and as it was found.
    expect(world.frozen).toBe(false);
    expect(Array.from(world.random.state)).toEqual(state);
    expect(world.hash()).toBe(before);
    // A freeze with no draw in it thaws quietly, after draws before it.
    world.random.next();
    const drawn = Array.from(world.random.state);
    world.freeze();
    world.thaw();
    expect(Array.from(world.random.state)).toEqual(drawn);
    // Thawing a world that is not frozen is nothing.
    world.random.next();
    world.thaw();
    expect(Array.from(world.random.state)).not.toEqual(drawn);
  });

  it("cannot be frozen in the middle of a transaction", () => {
    const { world } = populated();
    world.begin();
    expect(() => world.freeze()).toThrow(/inside a transaction/);
    world.rollback();
  });
});

// --- in an app --------------------------------------------------------------------

describe("the frame stage", () => {
  it.effect(
    "runs its systems when a frame is asked for, and the tick's when a tick is",
    () =>
      Effect.gen(function* () {
        const ran: string[] = [];
        const noting = (
          name: string,
          stage: "tick" | "frame" | "input" = "tick"
        ) => {
          const body = function* () {
            ran.push(name);
          };
          if (stage === "frame") {
            return System.frame(name, body);
          }
          if (stage === "input") {
            return System.input(name, body);
          }
          return System.tick(name, body);
        };
        const Pause = Action.define("fr/Pause", Schema.Struct({}));
        const pause = Action.handler(Pause, function* () {
          (yield* Phase.sets).set("paused");
        });
        const app = yield* App.make(
          App.define({
            systems: [
              noting("Clear", "frame"),
              noting("Tick"),
              noting("Draw", "frame"),
              noting("Hud", "frame").pipe(
                System.runIf(State.is(Phase, "paused"))
              ),
            ],
            handlers: [pause],
          })
        );
        expect(app.systemOrder).toEqual(["Tick"]);
        expect(app.frameOrder).toEqual(["Clear", "Draw", "Hud"]);
        yield* app.frame();
        expect(ran).toEqual(["Clear", "Draw"]);
        yield* app.tick(1);
        yield* app.tick(1);
        expect(ran).toEqual(["Clear", "Draw", "Tick", "Tick"]);
        ran.length = 0;
        yield* app.dispatch(Pause, {});
        yield* app.frame(0.5);
        // A state is entered by a tick, not by a frame.
        expect(ran).toEqual(["Clear", "Draw"]);
        yield* app.tick(1);
        ran.length = 0;
        yield* app.frame(0.5);
        expect(ran).toEqual(["Clear", "Draw", "Hud"]);
      })
  );

  it.effect(
    "has a stage before it and one after, as a tick has, and each runs whole before the next, however its systems are listed",
    () =>
      Effect.gen(function* () {
        const ran: string[] = [];
        const drawing = (
          name: string,
          stage: "preFrame" | "frame" | "postFrame"
        ) =>
          System.frame(name, function* () {
            // Each is told the frame, as any system that draws is.
            ran.push(`${name} ${(yield* Frame).alpha}`);
          }).pipe(System.inStage(stage));
        const app = yield* App.make(
          App.define({
            systems: [
              drawing("Fit", "postFrame"),
              drawing("Clear", "frame"),
              drawing("Show", "postFrame"),
              drawing("Draw", "frame"),
              System.tick("Tick", function* () {
                ran.push("Tick");
              }),
              drawing("Load", "preFrame"),
              drawing("Hud", "frame"),
              System.input("Listen", function* () {
                ran.push("Listen");
              }),
            ],
          })
        );
        // The stage first, then as listed.
        expect(app.frameOrder).toEqual([
          "Load",
          "Clear",
          "Draw",
          "Hud",
          "Fit",
          "Show",
        ]);
        expect(app.systemOrder).toEqual(["Tick"]);
        yield* app.frame(0.25);
        expect(ran).toEqual([
          "Load 0.25",
          "Clear 0.25",
          "Draw 0.25",
          "Hud 0.25",
          "Fit 0.25",
          "Show 0.25",
        ]);
        expect(System.frameStages).toEqual(["preFrame", "frame", "postFrame"]);
        expect(System.frameStages.map(System.isFrameStage)).toEqual([
          true,
          true,
          true,
        ]);
        expect(
          (["preUpdate", "update", "postUpdate", "input"] as const).map(
            System.isFrameStage
          )
        ).toEqual([false, false, false, false]);
      })
  );

  it("is the frame stage in all three as far as what a system may do goes: none changes the game, and none is a hook", () => {
    System.frame(
      "Vandal",
      // @ts-expect-error a frame system cannot write a singleton
      function* () {
        (yield* Score.writes).points = 1;
      }
    );
    const pre = System.frame("Pre", function* () {}).pipe(
      System.inStage("preFrame")
    );
    const post = System.frame("Post", function* () {}).pipe(
      System.inStage("postFrame")
    );
    expect([pre.stage, post.stage]).toEqual(["preFrame", "postFrame"]);
  });

  it.effect("is told how far the frame is between two ticks", () =>
    Effect.gen(function* () {
      const frames: unknown[] = [];
      const drawn: number[] = [];
      const Draw = System.frame("Draw", function* () {
        const frame = yield* Frame;
        const { delta } = yield* Time;
        frames.push({ ...frame });
        // Where the ball is now: where the last tick left it, and on.
        (yield* Seen).each((ball) => {
          drawn.push(ball.x + ball.vx * delta * frame.alpha);
        });
      });
      const app = yield* App.make(
        App.define({
          plugins: [racked({ x: 0, vx: 10 })],
          systems: [Roll, Draw],
        })
      );
      yield* app.tick(0.5);
      yield* app.frame(0, 0.016);
      yield* app.frame(0.5, 0.008);
      yield* app.tick(0.5);
      yield* app.frame(0.25);
      expect(frames).toEqual([
        { alpha: 0, delta: 0.016, count: 1 },
        { alpha: 0.5, delta: 0.008, count: 2 },
        { alpha: 0.25, delta: 0, count: 3 },
      ]);
      expect(drawn).toEqual([5, 7.5, 11.25]);
    })
  );

  it.effect(
    "is driven at the rate of frames while the simulation ticks at its own",
    () =>
      Effect.gen(function* () {
        const alphas: number[] = [];
        const Draw = System.frame("Draw", function* () {
          alphas.push(Math.round((yield* Frame).alpha * 100) / 100);
        });
        const app = yield* App.make(App.define({ systems: [Roll, Draw] }));
        const step = Driver.fixedStep(app, { hz: 10 });
        // Frames of 40 ms against ticks of 100 ms.
        const ticks = yield* Effect.forEach([0, 1, 2, 3, 4, 5, 6], () =>
          step(0.04)
        );
        expect(ticks).toEqual([0, 0, 1, 0, 1, 0, 0]);
        expect(alphas).toEqual([0.4, 0.8, 0.2, 0.6, 0, 0.4, 0.8]);
        expect(app.time.tick).toBe(2);
        // A long frame runs several ticks and then draws once.
        expect(yield* step(0.33)).toBe(4);
        expect(alphas.at(-1)).toBe(0.1);
        expect(alphas.length).toBe(8);
        // An app with no frame stage is driven as before.
        const plain = yield* App.make(App.define({ systems: [Roll] }));
        expect(yield* Driver.fixedStep(plain, { hz: 10 })(0.25)).toBe(2);
        expect(plain.frameOrder).toEqual([]);
        yield* plain.frame(0.5);
      })
  );

  it("cannot change the game: the ways that would are refused where they are written", () => {
    const Pinged = Event.define("fr/Pinged", Schema.Struct({}));
    System.frame(
      "Assign",
      // @ts-expect-error a frame system cannot write a query
      function* () {
        (yield* Balls).each((ball) => {
          ball.x = 99;
        });
      }
    );
    System.frame(
      "Set",
      // @ts-expect-error a frame system cannot set a component
      function* () {
        const [first] = (yield* Seen).entities();
        (yield* World.writes(Ball)).set(first!, Ball, { x: 99 });
      }
    );
    System.frame(
      "Spawn",
      // @ts-expect-error a frame system cannot spawn
      function* () {
        (yield* Commands.spawns(Ball)).spawn(Ball);
      }
    );
    System.frame(
      "Despawn",
      // @ts-expect-error a frame system cannot despawn
      function* () {
        (yield* Commands).despawn((yield* Seen).entities()[0]!);
      }
    );
    System.frame(
      "Score",
      // @ts-expect-error a frame system cannot write a singleton
      function* () {
        (yield* Score.writes).points = 1;
      }
    );
    System.frame(
      "Phase",
      // @ts-expect-error a frame system cannot set a state
      function* () {
        (yield* Phase.sets).set("paused");
      }
    );
    System.frame(
      "Ping",
      // @ts-expect-error a frame system cannot emit
      function* () {
        (yield* Pinged.emits).emit({});
      }
    );
    const Bus = System.frame("Bus", function* () {
      // @ts-expect-error the frame's events read, and have no emit
      (yield* Events).emit(Pinged, {});
    });
    expect(Bus.stage).toBe("frame");
  });

  it.effect(
    "draws its random numbers from a generator of its own, not the world's",
    () =>
      Effect.gen(function* () {
        const drawn: number[] = [];
        const Sparkle = System.frame("Sparkle", function* () {
          drawn.push((yield* Random).next(), yield* EffectRandom.next);
        });
        const app = yield* App.make(App.define({ systems: [Sparkle, Roll] }), {
          seed: 5,
        });
        const world = yield* app.read(World);
        const before = world.hash();
        yield* app.frame();
        yield* app.frame();
        expect(new Set(drawn).size).toBe(4);
        // The hash holds the state of the world's generator.
        expect(world.hash()).toBe(before);
        // Seeded, so the same game sparkles the same way.
        const again = yield* App.make(
          App.define({ systems: [Sparkle, Roll] }),
          { seed: 5 }
        );
        drawn.length = 0;
        yield* again.frame();
        yield* again.frame();
        const first = [...drawn];
        drawn.length = 0;
        const third = yield* App.make(
          App.define({ systems: [Sparkle, Roll] }),
          { seed: 5 }
        );
        yield* third.frame();
        yield* third.frame();
        expect(drawn).toEqual(first);
      })
  );

  it.effect(
    "finds a draw from the world's generator when the frame ends, and takes it back",
    () =>
      Effect.gen(function* () {
        let cheat = true;
        const drawn: string[] = [];
        const Cheat = System.frame("Cheat", function* () {
          if (cheat) {
            (yield* Dice).next();
          }
        });
        const After = System.frame("After", function* () {
          drawn.push("After");
        });
        // Not checked with verifyFrames: this is found either way.
        const app = yield* App.make(
          App.define({
            plugins: [racked({ x: 1, vx: 1 }), Kept],
            systems: [Cheat, After, Roll],
          }),
          { seed: 5 }
        );
        const world = yield* app.read(World);
        yield* app.tick(1);
        const before = world.hash();
        expect(yield* thrown(app.frame())).toThrow(
          /A draw from world\.random was made while the world is frozen/
        );
        expect(world.hash()).toBe(before);
        // The frame ran to its end first, and the outcome is a defect.
        expect(drawn).toEqual(["After"]);
        const exit = yield* Effect.exit(app.frame(0));
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
        expect(world.hash()).toBe(before);
        // The app is not left in a frame, nor the world frozen: it ticks,
        // and draws once it behaves.
        yield* app.tick(1);
        expect(world.hash()).not.toBe(before);
        cheat = false;
        yield* app.frame();
        expect(Exit.isSuccess(yield* Effect.exit(app.frame(0)))).toBe(true);
      })
  );

  it.effect(
    "issues an action as input from outside: logged, applied next tick, replayed without it",
    () =>
      Effect.gen(function* () {
        const Kick = Action.define(
          "fr/Kick",
          Schema.Struct({ by: Schema.Int })
        );
        const kick = Action.handler(Kick, function* ({ by }) {
          (yield* Balls).each((ball) => {
            ball.vx += by;
          });
        });
        // A button in the picture: pressed in the third frame.
        const Button = System.frame("Button", function* () {
          if ((yield* Frame).count === 3) {
            (yield* Action.Actions).enqueue(Kick, { by: 4 });
          }
        });
        const Begin = Plugin.make("fr/Begin", {
          setup: Effect.map(Commands.spawns(Ball), (commands) => {
            commands.spawn(Ball.of({ x: 0, vx: 1 }));
          }),
        });
        const app = yield* App.make(
          App.define({
            plugins: [Begin],
            systems: [Roll, Button],
            handlers: [kick],
          }),
          { hashEvery: 1 }
        );
        for (let n = 0; n < 5; n++) {
          yield* app.tick(1);
          yield* app.frame();
        }
        expect(yield* ballsOf(app)).toEqual([{ x: 1 + 1 + 1 + 5 + 5, vx: 5 }]);
        expect(
          app.actionLog.filter((entry) => !Action.isHashCheck(entry))
        ).toEqual([
          { tick: 3, name: "fr/Kick", payload: { by: 4 }, queued: true },
        ]);
        // The replay has no button and draws no frame.
        const played = yield* Replay.record(app);
        const headless = yield* Replay.verify(
          played,
          App.define({ plugins: [Begin], systems: [Roll], handlers: [kick] }),
          { hashEvery: 1 }
        );
        expect((yield* headless.read(World)).hash()).toBe(
          (yield* app.read(World)).hash()
        );
        // Nor may a frame dispatch: that would change the game there and then.
        let own: App.App | undefined;
        const Hasty = System.frame("Hasty", function* () {
          if (own !== undefined) {
            yield* Effect.orDie(own.dispatchByName("fr/Kick", { by: 1 }));
          }
        });
        const hasty = yield* App.make(
          App.define({
            plugins: [Begin],
            systems: [Hasty],
            handlers: [kick],
          }),
          { hashEvery: 1 }
        );
        own = hasty;
        expect(yield* thrown(hasty.frame())).toThrow(
          /dispatch\("fr\/Kick"\) was called during the frame stage.*Actions\.enqueue/
        );
      })
  );

  it.effect(
    "refuses a tick, a frame or a save from inside a frame, and a frame from inside a tick",
    () =>
      Effect.gen(function* () {
        let inFrame: Effect.Effect<unknown> | undefined;
        let inTick: Effect.Effect<unknown> | undefined;
        const drawn: number[] = [];
        const Reenter = System.frame("Reenter", function* () {
          drawn.push((yield* Frame).count);
          if (inFrame !== undefined) {
            yield* inFrame;
          }
        });
        const InTick = System.tick("InTick", function* () {
          if (inTick !== undefined) {
            yield* inTick;
          }
        });
        const app: App.App = yield* App.make(
          App.define({ systems: [Reenter, InTick] })
        );
        inFrame = app.tick(1);
        expect(yield* thrown(app.frame())).toThrow(
          /App\.tick was called from inside a frame/
        );
        inFrame = app.frame();
        expect(yield* thrown(app.frame())).toThrow(
          /App\.frame was called from inside a frame/
        );
        inFrame = Effect.orDie(Save.make(app));
        expect(yield* thrown(app.frame())).toThrow(
          /Save\.make\(\) was called during/
        );
        inFrame = undefined;
        inTick = app.frame();
        drawn.length = 0;
        expect(yield* thrown(app.tick(1))).toThrow(
          /App\.frame was called from inside a tick/
        );
        // Nothing was drawn in the middle of the tick.
        expect(drawn).toEqual([]);
        inTick = undefined;
        yield* app.tick(1);
        yield* app.frame();
      })
  );

  it("keeps real time out of the simulation, and hooks out of the frame stage", () => {
    System.tick(
      "Peek",
      // @ts-expect-error Frame is the frame stage's
      function* () {
        void (yield* Frame).alpha;
      }
    );
    const splash = State.onEnter(Phase, "paused", "Splash", function* () {});
    expect(splash.stage).toBe("update");
  });
});

describe("what the frame stage reads", () => {
  const Bounced = Event.define("fr/Bounced", Schema.Struct({ at: Schema.Int }));

  it.effect(
    "sees every event once, however many ticks ran since the last frame",
    () =>
      Effect.gen(function* () {
        const heard: number[] = [];
        const late: number[] = [];
        const Listen = System.frame("Listen", function* () {
          for (const { at } of (yield* Bounced).read()) {
            heard.push(at);
          }
        });
        const Late = System.tick("Late", function* () {
          if ((yield* Time).tick >= 4) {
            for (const { at } of (yield* Bounced).read()) {
              late.push(at);
            }
          }
        });
        const Emit = System.tick("Emit", function* () {
          (yield* Bounced.emits).emit({ at: (yield* Time).tick });
        });
        const app = yield* App.make(
          App.define({ systems: [Late, Emit, Listen] })
        );
        yield* app.tick(1);
        yield* app.frame();
        expect(heard).toEqual([1]);
        // Four ticks with no frame between them, as after a hitch.
        for (let n = 0; n < 4; n++) {
          yield* app.tick(1);
        }
        yield* app.frame();
        expect(heard).toEqual([1, 2, 3, 4, 5]);
        yield* app.frame();
        expect(heard).toEqual([1, 2, 3, 4, 5]);
        // The simulation cannot tell that anything was kept for the frame
        // stage: a system that first reads on tick 4 hears what it would
        // have heard with no frame stage at all.
        const headless = yield* App.make(App.define({ systems: [Late, Emit] }));
        const without: number[] = [];
        late.length = 0;
        for (let n = 0; n < 5; n++) {
          yield* headless.tick(1);
        }
        without.push(...late);
        expect(without).toEqual([3, 4]);
        late.length = 0;
        const again = yield* App.make(
          App.define({ systems: [Late, Emit, Listen] })
        );
        yield* again.tick(1);
        yield* again.frame();
        for (let n = 0; n < 4; n++) {
          yield* again.tick(1);
        }
        expect(late).toEqual(without);
        expect((yield* again.inspect()).stores).toEqual(
          (yield* headless.inspect()).stores
        );
        // A system that sat ticks out is no different: when it reads
        // again it goes no further back than it could with no frame stage.
        const sat: number[] = [];
        const Sometimes = System.tick("Sometimes", function* () {
          for (const { at } of (yield* Bounced).read()) {
            sat.push(at);
          }
        }).pipe(
          System.runIf(Effect.map(Time, ({ tick }) => tick === 1 || tick === 6))
        );
        const run = Effect.fnUntraced(function* (each: App.App) {
          sat.length = 0;
          yield* each.tick(1);
          yield* each.frame();
          for (let n = 0; n < 5; n++) {
            yield* each.tick(1);
          }
          return [...sat];
        });
        const all = App.define({ systems: [Sometimes, Emit, Listen] });
        expect(yield* run(yield* App.make(all))).toEqual([5]);
        const unheard = App.define({ systems: [Sometimes, Emit] });
        expect(yield* run(yield* App.make(unheard))).toEqual([5]);
        // Nor can a save: it holds what the simulation has yet to read, and
        // nothing that was only kept for the frame stage, or of its readers.
        const saves = yield* Effect.forEach([again, headless], (each) =>
          Effect.map(Save.make(each), (save) => readSnapshot(save.world).stores)
        );
        expect(saves[0]).toEqual(saves[1]);
        expect(saves[0]).toEqual([
          {
            name: Event.STORE,
            data: [{ name: "fr/Bounced", waiting: [{ at: 5 }], read: {} }],
          },
        ]);
      })
  );

  it.effect(
    "stops keeping events for a frame stage that has stopped running",
    () =>
      Effect.gen(function* () {
        const heard: number[] = [];
        const Listen = System.frame("Listen", function* () {
          heard.push((yield* Bounced).read().length);
        });
        const Emit = System.tick("Emit", function* () {
          (yield* Bounced.emits).emit({ at: (yield* Time).tick });
        });
        const app = yield* App.make(App.define({ systems: [Emit, Listen] }));
        // A frame stage that keeps running is kept for, however long.
        for (let n = 0; n < 700; n++) {
          yield* app.tick(1);
          yield* app.frame();
        }
        for (let n = 0; n < 4; n++) {
          yield* app.tick(1);
        }
        yield* app.frame();
        expect(heard.at(-1)).toBe(4);
        heard.length = 0;
        yield* app.tick(1);
        yield* app.frame();
        for (let n = 0; n < 500; n++) {
          yield* app.tick(1);
        }
        yield* app.frame();
        // All 500 were kept.
        expect(heard).toEqual([1, 500]);
        for (let n = 0; n < 2000; n++) {
          yield* app.tick(1);
        }
        yield* app.frame();
        // After 600 ticks without a frame the app stopped keeping them:
        // what is left is what any reader would find.
        expect(heard.at(-1)).toBeLessThan(5);
      })
  );

  it.effect(
    "has a place of its own in what changed, which is not the simulation's and not saved",
    () =>
      Effect.gen(function* () {
        const drawn: number[] = [];
        const counted: number[] = [];
        const Draw = System.frame("Draw", function* () {
          let rows = 0;
          // Raw columns of what it watches: nothing is written in a frame.
          (yield* Watched).eachChunk((start, end) => {
            rows += end - start;
          });
          drawn.push(rows);
        });
        const Count = System.tick("Count", function* () {
          counted.push((yield* Moved).entities().length);
        });
        const Nudge = System.tick("Nudge", function* () {
          const { tick } = yield* Time;
          (yield* Balls).each((ball, entity) => {
            if (entityIndex(entity) === tick % 3) {
              ball.x += 1;
            }
          });
        });
        const BallGame = App.define({
          plugins: [racked({ x: 0, vx: 0 }, { x: 1, vx: 0 }, { x: 2, vx: 0 })],
          systems: [Nudge, Count, Draw],
        });
        const app = yield* App.make(BallGame, { hashEvery: 1 });
        yield* app.frame();
        yield* app.tick(1);
        yield* app.tick(1);
        yield* app.frame();
        yield* app.frame();
        // The first frame draws everything; the next, the two that moved.
        expect(drawn).toEqual([3, 2, 0]);
        // The simulation's own reader saw each change once.
        expect(counted).toEqual([3, 1]);

        yield* app.tick(1);
        const save = yield* Effect.exit(Save.make(app));
        if (Exit.isFailure(save)) {
          throw new Error("the save was refused");
        }
        // The save knows the simulation's reader and not the frame's.
        const visits = readSnapshot(save.value.world).stores.find(
          (store) => store.name === VISITS
        )?.data as { readers: Record<string, number> }[];
        const readers = visits.flatMap((changes) =>
          Object.keys(changes.readers)
        );
        expect(readers.length).toBe(1);
        expect(readers[0]).toMatch(/^Count\n/);
        const read = Save.decode(Save.encode(save.value));
        if (Exit.isFailure(read)) {
          throw new Error("the save did not decode");
        }
        const loaded = yield* App.make(BallGame, {
          save: read.value,
          hashEvery: 1,
        });
        drawn.length = 0;
        counted.length = 0;
        yield* loaded.frame();
        yield* loaded.tick(1);
        // A loaded game has everything still to draw, and its simulation
        // goes on from where it was.
        expect(drawn).toEqual([3]);
        expect(counted).toEqual([1]);
      })
  );

  it.effect(
    "changes nothing: a game drawn every frame is the game that was never drawn",
    () =>
      Effect.gen(function* () {
        const Watch = System.frame("Watch", function* () {
          let sum = 0;
          (yield* Seen).each((ball) => {
            sum += ball.x;
          });
          (yield* Watched).each(() => {});
          (yield* Bounced).read();
          void (yield* Score).points;
          void (yield* Phase).value;
          void (yield* Random).next();
          void sum;
        });
        const Tally = System.tick("Tally", function* () {
          (yield* Score.writes).points += (yield* Bounced).read().length;
          const random = yield* Random;
          (yield* Balls).each((ball) => {
            ball.x += random.next();
          });
          (yield* Bounced.emits).emit({ at: 0 });
        });
        const Rack = racked(
          { x: 0, vx: 1 },
          { x: 1, vx: 1 },
          { x: 2, vx: 1 },
          { x: 3, vx: 1 }
        );
        const make = (
          game: App.Game<
            readonly System.System<never, BuiltIn>[],
            readonly [],
            readonly [typeof Rack]
          >
        ) =>
          Effect.gen(function* () {
            const app = yield* App.make(game, {
              hashEvery: 1,
              seed: 3,
              verifyFrames: true,
            });
            return { app, world: yield* app.read(World) };
          });
        const { app: drawn, world: drawnWorld } = yield* make(
          App.define({ plugins: [Rack], systems: [Roll, Tally, Watch] })
        );
        const { app: undrawn, world: undrawnWorld } = yield* make(
          App.define({ plugins: [Rack], systems: [Roll, Tally] })
        );
        for (let n = 0; n < 20; n++) {
          yield* drawn.tick(1 / 60);
          for (let f = 0; f < n % 3; f++) {
            yield* drawn.frame(f / 3, 0.005);
          }
          yield* undrawn.tick(1 / 60);
          expect(drawnWorld.hash()).toBe(undrawnWorld.hash());
        }
        expect(drawn.actionLog).toEqual(undrawn.actionLog);
        const saved = [
          yield* Effect.exit(Save.make(drawn)),
          yield* Effect.exit(Save.make(undrawn)),
        ].map((save) =>
          Exit.isSuccess(save) ? Save.encode(save.value) : undefined
        );
        expect(saved[0]).toEqual(saved[1]);
      })
  );
});

describe("a frame stage that is checked", () => {
  const Sneak = (how: "raw" | "random" | "none") =>
    System.frame("Sneak", function* () {
      if (how === "raw") {
        (yield* Seen).eachChunk((start, end, balls) => {
          for (let i = start; i < end; i++) {
            // @ts-expect-error a read query's columns are not assigned
            balls.x[i]! += 1;
          }
        });
      } else if (how === "random") {
        (yield* Dice).next();
      }
    });
  const Honest = System.frame("Honest", function* () {
    void (yield* Seen).count();
  });

  it.effect(
    "holds what a system does in place of running to the same, and names that system",
    () =>
      Effect.gen(function* () {
        // It does not run, and what it does then draws from the world's generator.
        const Idle = Honest.pipe(
          System.runIf(Effect.succeed(false)),
          System.otherwise(Effect.map(Dice, (dice) => void dice.next()))
        );
        const app = yield* App.make(
          App.define({
            plugins: [racked({ x: 1, vx: 1 }), Kept],
            systems: [Idle],
          }),
          { verifyFrames: true }
        );
        const exit = yield* Effect.exit(app.frame(0));
        const error = Exit.isFailure(exit)
          ? Cause.squash(exit.cause)
          : undefined;
        expect(error).toBeInstanceOf(App.FrameChangedWorld);
        expect(error).toMatchObject({ system: "Honest" });
      })
  );

  it.effect(
    "finds a draw from the world's generator, names the system, and takes it back",
    () =>
      Effect.gen(function* () {
        const app = yield* App.make(
          App.define({
            plugins: [racked({ x: 1, vx: 1 }), Kept],
            systems: [Honest, Sneak("random"), Roll],
          }),
          { verifyFrames: true }
        );
        const world = yield* app.read(World);
        yield* app.tick(1);
        const exit = yield* Effect.exit(app.frame(0.5));
        const error = Exit.isFailure(exit)
          ? Cause.squash(exit.cause)
          : undefined;
        expect(error).toBeInstanceOf(App.FrameChangedWorld);
        expect(error).toMatchObject({ system: "Sneak", frame: 1 });
        expect((error as Error).message).toMatch(
          /after system "Sneak" ran in frame 1.*world\.random/
        );
        // It is a defect: nothing in the error channel to handle.
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
        const before = world.hash();
        expect(yield* thrown(app.frame())).toThrow(App.FrameChangedWorld);
        expect(world.hash()).toBe(before);
      })
  );

  it.effect(
    "refuses a write through a raw column where it is made, and puts it back",
    () =>
      Effect.gen(function* () {
        const app = yield* App.make(
          App.define({
            plugins: [racked({ x: 1, vx: 1 }), Kept],
            systems: [Honest, Sneak("raw"), Roll],
          }),
          { verifyFrames: true }
        );
        const world = yield* app.read(World);
        yield* app.tick(1);
        const before = world.hash();
        const exit = yield* Effect.exit(app.frame(0.5));
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(
          new Error(
            'eachChunk() wrote "fr/Ball.x", which the query only reads, through its raw column. No change query would see the write, and no refusal would undo it, so it has been put back. Name "fr/Ball" in Query.writes to write it, or write it with each().'
          )
        );
        expect(world.hash()).toBe(before);
      })
  );

  it.effect(
    "passes a frame stage that leaves the world alone, and is off unless asked for",
    () =>
      Effect.gen(function* () {
        const checked = yield* App.make(
          App.define({
            plugins: [racked({ x: 1, vx: 1 }), Kept],
            systems: [Honest, Sneak("none"), Roll],
          }),
          { verifyFrames: true }
        );
        yield* checked.tick(1);
        yield* checked.frame();
        // The world a frame is held to is the one it found, not the last one.
        yield* checked.tick(1);
        yield* checked.frame(0.5);
        // Unchecked, the write goes through: it is the game's to avoid.
        const unchecked = yield* App.make(
          App.define({
            plugins: [racked({ x: 1, vx: 1 }), Kept],
            systems: [Sneak("raw"), Roll],
          })
        );
        yield* unchecked.frame();
        expect(yield* ballsOf(unchecked)).toEqual([{ x: 2, vx: 1 }]);
      })
  );
});

describe("what a frame or input system keeps", () => {
  /** A camera that goes round, as far as it has gone in this app, and what was let go. */
  const orbiting = () => {
    const released: number[] = [];
    const Orbit = System.local(
      () => ({ angle: 0 }),
      ({ angle }) => {
        released.push(angle);
      }
    );
    const seen: number[] = [];
    const Camera = System.frame("fr/Camera", function* () {
      const orbit = yield* Orbit;
      orbit.angle += (yield* Frame).delta;
      seen.push(orbit.angle);
    });
    return { Orbit, Camera, seen, released };
  };

  it.effect(
    "lasts from one frame to the next, is each app's own, and is let go of when the app closes",
    () =>
      Effect.gen(function* () {
        const { Camera, released, seen } = orbiting();
        const Game = App.define({ systems: [Roll, Camera] });
        const one = yield* App.make(Game);
        const two = yield* App.make(Game);
        yield* one.frame(1, 1);
        yield* one.frame(1, 1);
        yield* two.frame(1, 5);
        yield* one.frame(1, 1);
        expect(seen).toEqual([1, 2, 5, 3]);
        yield* one.close;
        expect(released).toEqual([3]);
        yield* two.close;
        expect(released).toEqual([3, 5]);
      })
  );

  it.effect(
    "is no part of the game: a rewind leaves it as it is, and the hash and the save leave it out",
    () =>
      Effect.gen(function* () {
        const { Camera, seen } = orbiting();
        const app = yield* App.make(
          App.define({
            plugins: [racked({ x: 0, vx: 1 })],
            systems: [Roll, Camera],
          })
        );
        const bare = yield* App.make(
          App.define({ plugins: [racked({ x: 0, vx: 1 })], systems: [Roll] })
        );
        yield* app.tick(1);
        yield* bare.tick(1);
        const moment = yield* Timeline.capture(app);
        yield* app.frame(1, 1);
        yield* app.tick(1);
        yield* app.frame(1, 1);
        yield* Timeline.rewind(app, moment);
        yield* app.frame(1, 1);
        // Three frames have gone by, whatever the game went back to.
        expect(seen).toEqual([1, 2, 3]);
        expect(yield* ballsOf(app)).toEqual([{ x: 1, vx: 1 }]);
        expect((yield* app.read(World)).hash()).toBe(
          (yield* bare.read(World)).hash()
        );
        expect(Save.encode(yield* Save.make(app))).toEqual(
          Save.encode(yield* Save.make(bare))
        );
      })
  );

  it.effect(
    "is shared by the systems that yield it, so an input system sets what a frame system reads",
    () =>
      Effect.gen(function* () {
        const Shown = System.local(() => ({ deck: true }));
        const Toggle = System.input("fr/Toggle", function* () {
          const shown = yield* Shown;
          shown.deck = !shown.deck;
        });
        const drawn: boolean[] = [];
        const Draw = System.frame("fr/DrawDeck", function* () {
          drawn.push((yield* Shown).deck);
        });
        const app = yield* App.make(App.define({ systems: [Toggle, Draw] }));
        yield* app.frame();
        yield* app.input();
        yield* app.frame();
        yield* app.input();
        yield* app.frame();
        expect(drawn).toEqual([true, false, true]);
      })
  );

  it("is kept by a frame or an input system, and by no code of the tick", () => {
    const { Orbit } = orbiting();
    const Drawn = System.frame("fr/Drawn", function* () {
      void (yield* Orbit).angle;
    });
    System.input("fr/Heard", function* () {
      void (yield* Orbit).angle;
    });
    System.tick(
      "fr/Ticked",
      // @ts-expect-error the tick keeps what it keeps in the world
      function* () {
        void (yield* Orbit).angle;
      }
    );
    const Turn = Action.define("fr/Turn", Schema.Struct({}));
    Action.handler(
      Turn,
      // @ts-expect-error a handler keeps what it keeps in the world
      function* () {
        void (yield* Orbit).angle;
      }
    );
    expect(Drawn.stage).toBe("frame");
  });
});
