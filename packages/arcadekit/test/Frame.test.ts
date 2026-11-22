import { Cause, Effect, Random as EffectRandom, Exit, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  Action,
  App,
  CommandBuffer,
  Commands,
  Component,
  Driver,
  EcsWorld,
  Event,
  Events,
  Field,
  Frame,
  Query,
  Random,
  Save,
  Singleton,
  State,
  System,
  Time,
  World,
  readSnapshot,
} from "../src/index";
import type { Entity } from "../src/index";
import type { BuiltIn } from "../src/Services";

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
const Moved = Query.all(Ball).pipe(Query.changed(Ball), Query.writes(Ball));

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): A =>
  Effect.runSync(Effect.scoped(effect));

const Roll = System.make("Roll", function* () {
  const { delta } = yield* Time;
  (yield* Balls).each((ball) => {
    ball.x += ball.vx * delta;
  });
});

describe("a frozen world", () => {
  const populated = (): { world: EcsWorld; ball: Entity } => {
    const world = new EcsWorld({ seed: 1 });
    const ball = world.spawn(Ball.of({ x: 1, vx: 2 }), Glow.of({ level: 3 }));
    world.spawn(Ball.of({ x: 5, vx: 0 }));
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
    expect(sum).toBe(12);
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
    const moved = world.view(Moved, "drawer");
    const other = world.view(Moved, "other");
    other.entities();
    world.freeze();
    const seen: number[] = [];
    // Thawed, this throws: it would take its own visit for a change.
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
  it("runs its systems when a frame is asked for, and the tick's when a tick is", () => {
    run(
      Effect.gen(function* () {
        const ran: string[] = [];
        const noting = (name: string) =>
          System.make(name, function* () {
            ran.push(name);
          });
        const app = yield* App.make({
          systems: [
            noting("Draw").pipe(System.inStage("frame")),
            noting("Tick"),
            noting("Hud").pipe(
              System.inStage("frame"),
              System.runIf(State.is(Phase, "paused"))
            ),
            noting("Clear").pipe(
              System.inStage("frame"),
              System.before("Draw")
            ),
          ],
        });
        expect(app.systemOrder).toEqual(["Tick"]);
        expect(app.frameOrder).toEqual(["Clear", "Draw", "Hud"]);
        app.frame(0);
        expect(ran).toEqual(["Clear", "Draw"]);
        app.tick(1);
        app.tick(1);
        expect(ran).toEqual(["Clear", "Draw", "Tick", "Tick"]);
        ran.length = 0;
        yield* Effect.map(Phase, (phase) => phase.set("paused")).pipe(
          Effect.provideService(World, app.world)
        );
        app.frame(0.5);
        // A state is entered by a tick, not by a frame.
        expect(ran).toEqual(["Clear", "Draw"]);
        app.tick(1);
        ran.length = 0;
        app.frame(0.5);
        expect(ran).toEqual(["Clear", "Draw", "Hud"]);
      })
    );
  });

  it("has a stage before it and one after, as a tick has, and each runs whole before the next, however its systems are listed", () => {
    run(
      Effect.gen(function* () {
        const ran: string[] = [];
        const noting = (name: string, stage: System.Stage) =>
          System.make(name, function* () {
            // Each is told the frame, as any system that draws is.
            ran.push(`${name} ${(yield* Frame).alpha}`);
          }).pipe(System.inStage(stage));
        const app = yield* App.make({
          systems: [
            noting("Show", "postFrame"),
            noting("Draw", "frame"),
            noting("Tick", "update"),
            noting("Load", "preFrame"),
            noting("Hud", "frame"),
            noting("Fit", "postFrame").pipe(System.before("Show")),
            noting("Clear", "frame").pipe(System.before("Draw")),
            noting("Listen", "input"),
          ],
        });
        // The stage first, then what the systems say, then as listed.
        expect(app.frameOrder).toEqual([
          "Load",
          "Clear",
          "Draw",
          "Hud",
          "Fit",
          "Show",
        ]);
        expect(app.systemOrder).toEqual(["Tick"]);
        app.frame(0.25);
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
  });

  it("is the frame stage in all three as far as what a system may do goes: none changes the game, and none is a hook", () => {
    for (const stage of ["preFrame", "postFrame"] as const) {
      const made = App.make({
        systems: [
          System.make("Vandal", function* () {
            (yield* Score).points = 1;
          }).pipe(System.inStage(stage)),
        ],
      });
      const app = run(made);
      expect(() => app.frame(0), stage).toThrow('singleton "fr/Score"');
      expect(app.world.singleton(Score).points).toBe(0);
      // A tick does not run it.
      app.tick(1);
      expect(app.world.singleton(Score).points).toBe(0);
      expect(
        () =>
          run(
            App.make({
              systems: [
                System.make("Splash", function* () {}).pipe(
                  System.inStage(stage),
                  State.onEnter(Phase, "paused")
                ),
              ],
            })
          ),
        stage
      ).toThrow(/System "Splash" is a hook and is in the frame stage/);
    }
  });

  it("takes a system's word about one of another stage when it is so already, and refuses it when it cannot be", () => {
    const sys = (name: string, stage: System.Stage) =>
      System.make(name, function* () {}).pipe(System.inStage(stage));
    const names = (list: readonly System.System<unknown, unknown>[]) =>
      System.order(list).map((system) => system.name);
    // True as it stands: nothing is moved, and nothing is wrong.
    expect(
      names([
        sys("Show", "postFrame"),
        sys("Camera", "frame").pipe(System.before("Show")),
        sys("Draw", "frame").pipe(System.after("Load")),
        sys("Load", "preFrame").pipe(System.before("Draw")),
        sys("Last", "postFrame").pipe(System.after("Camera")),
      ])
    ).toEqual(["Load", "Camera", "Draw", "Show", "Last"]);
    // And of a tick's stages the same.
    expect(
      names([
        sys("Late", "postUpdate").pipe(System.after("Rules")),
        sys("Rules", "update").pipe(System.after("Early")),
        sys("Early", "preUpdate").pipe(System.before("Late")),
      ])
    ).toEqual(["Early", "Rules", "Late"]);
    // What cannot be: a stage runs whole before the next.
    expect(() =>
      System.order([
        sys("Show", "postFrame"),
        sys("Camera", "frame").pipe(System.after("Show")),
      ])
    ).toThrow(
      'System "Camera" must run after "Show", which is in the "postFrame" stage: that stage runs after every system of the "frame" stage, this one among them'
    );
    expect(() =>
      System.order([
        sys("Load", "preFrame"),
        sys("Draw", "frame").pipe(System.before("Load")),
      ])
    ).toThrow(
      'System "Draw" must run before "Load", which is in the "preFrame" stage: that stage runs before every system of the "frame" stage, this one among them'
    );
    expect(() =>
      System.order([
        sys("Rules", "update").pipe(System.after("Late")),
        sys("Late", "postUpdate"),
      ])
    ).toThrow('which is in the "postUpdate" stage');
    expect(() =>
      System.order([
        sys("Late", "postUpdate").pipe(System.before("Rules")),
        sys("Rules", "update"),
      ])
    ).toThrow('which is in the "update" stage');
    // And a system that is nowhere is still not there.
    expect(() =>
      System.order([sys("Draw", "frame").pipe(System.after("Nobody"))])
    ).toThrow('must run after "Nobody", which is not in the "frame" stage');
    expect(() =>
      System.order([sys("Draw", "frame").pipe(System.before("Nobody"))])
    ).toThrow('must run before "Nobody", which is not in the "frame" stage');
    // A frame's systems and a tick's are never ordered against each other:
    // an app sorts them apart.
    expect(() =>
      run(
        App.make({
          systems: [
            sys("Rules", "update"),
            sys("Draw", "frame").pipe(System.after("Rules")),
          ],
        })
      )
    ).toThrow('must run after "Rules", which is not in the "frame" stage');
  });

  it("is told how far the frame is between two ticks", () => {
    run(
      Effect.gen(function* () {
        const frames: unknown[] = [];
        const drawn: number[] = [];
        const Draw = System.make("Draw", function* () {
          const frame = yield* Frame;
          const { delta } = yield* Time;
          frames.push({ ...frame });
          // Where the ball is now: where the last tick left it, and on.
          (yield* Balls).each((ball) => {
            drawn.push(ball.x + ball.vx * delta * frame.alpha);
          });
        }).pipe(System.inStage("frame"));
        const app = yield* App.make({ systems: [Roll, Draw] });
        app.world.spawn(Ball.of({ x: 0, vx: 10 }));
        app.tick(0.5);
        app.frame(0, 0.016);
        app.frame(0.5, 0.008);
        app.tick(0.5);
        app.frame(0.25);
        expect(frames).toEqual([
          { alpha: 0, delta: 0.016, count: 1 },
          { alpha: 0.5, delta: 0.008, count: 2 },
          { alpha: 0.25, delta: 0, count: 3 },
        ]);
        expect(drawn).toEqual([5, 7.5, 11.25]);
      })
    );
  });

  it("is driven at the rate of frames while the simulation ticks at its own", () => {
    run(
      Effect.gen(function* () {
        const alphas: number[] = [];
        const Draw = System.make("Draw", function* () {
          alphas.push(Math.round((yield* Frame).alpha * 100) / 100);
        }).pipe(System.inStage("frame"));
        const app = yield* App.make({ systems: [Roll, Draw] });
        const step = Driver.fixedStep(app, { hz: 10 });
        // Frames of 40 ms against ticks of 100 ms.
        const ticks = [0, 1, 2, 3, 4, 5, 6].map(() => step(0.04));
        expect(ticks).toEqual([0, 0, 1, 0, 1, 0, 0]);
        expect(alphas).toEqual([0.4, 0.8, 0.2, 0.6, 0, 0.4, 0.8]);
        expect(app.time.tick).toBe(2);
        // A long frame runs several ticks and then draws once.
        expect(step(0.33)).toBe(4);
        expect(alphas.at(-1)).toBe(0.1);
        expect(alphas.length).toBe(8);
        // An app with no frame stage is driven as before.
        const plain = yield* App.make({ systems: [Roll] });
        expect(Driver.fixedStep(plain, { hz: 10 })(0.25)).toBe(2);
        expect(plain.frameOrder).toEqual([]);
        plain.frame(0.5);
      })
    );
  });

  it("cannot change the game: whatever would throws, and names what did", () => {
    const Pinged = Event.define("fr/Pinged", Schema.Struct({}));
    const attempts: Record<string, Effect.Effect<unknown, never, BuiltIn>> = {
      'assignment to "fr/Ball.x"': Effect.map(Balls, (balls) =>
        balls.each((ball) => {
          ball.x = 99;
        })
      ),
      "World.set()": Effect.map(World, (world) =>
        world.set(world.view(Balls).entities()[0]!, Ball, { x: 99 })
      ),
      "A spawn": Effect.map(Commands, (commands) => commands.spawn(Ball)),
      "Commands.despawn()": Effect.gen(function* () {
        (yield* Commands).despawn((yield* Balls).entities()[0]!);
      }),
      'singleton "fr/Score"': Effect.map(Score, (score) => {
        score.points = 1;
      }),
      'singleton "fr/Phase"': Effect.map(Phase, (phase) => phase.set("paused")),
      'event "fr/Pinged" was emitted in the frame stage': Effect.map(
        Pinged,
        (pinged) => pinged.emit({})
      ),
      // Around a system's handle, through the bus an app also hands out.
      'The event "fr/Pinged" was emitted in the frame stage or the input stage':
        Effect.map(Effect.service(Events), (events) => events.emit(Pinged, {})),
    };
    for (const [what, attempt] of Object.entries(attempts)) {
      run(
        Effect.gen(function* () {
          const Vandal = System.make("Vandal", function* () {
            yield* attempt;
          }).pipe(System.inStage("frame"));
          const app = yield* App.make({
            systems: [Roll, Vandal],
            checkpointEvery: 1,
          });
          app.world.spawn(Ball.of({ x: 1, vx: 1 }));
          app.tick(1);
          const before = app.world.hash();
          expect(() => app.frame(0), what).toThrow(what);
          expect(app.world.hash(), what).toBe(before);
          expect(app.commands.size, what).toBe(0);
          expect(app.events.pending(Pinged), what).toBe(0);
          // And the app is not left frozen, or in the middle of a frame.
          app.tick(1);
          expect(app.world.frozen).toBe(false);
          const exit = app.frameExit(0);
          expect(Exit.isFailure(exit), what).toBe(true);
        })
      );
    }
  });

  it("draws its random numbers from a generator of its own, not the world's", () => {
    run(
      Effect.gen(function* () {
        const drawn: number[] = [];
        const Sparkle = System.make("Sparkle", function* () {
          drawn.push((yield* Random).next(), yield* EffectRandom.next);
        }).pipe(System.inStage("frame"));
        const app = yield* App.make({ systems: [Sparkle, Roll], seed: 5 });
        const before = app.world.hash();
        const state = Array.from(app.world.random.state);
        app.frame(0);
        app.frame(0);
        expect(new Set(drawn).size).toBe(4);
        expect(app.world.hash()).toBe(before);
        expect(Array.from(app.world.random.state)).toEqual(state);
        // Seeded, so the same game sparkles the same way.
        const again = yield* App.make({ systems: [Sparkle, Roll], seed: 5 });
        drawn.length = 0;
        again.frame(0);
        again.frame(0);
        const first = [...drawn];
        drawn.length = 0;
        const third = yield* App.make({ systems: [Sparkle, Roll], seed: 5 });
        third.frame(0);
        third.frame(0);
        expect(drawn).toEqual(first);
      })
    );
  });

  it("finds a draw from the world's generator when the frame ends, and takes it back", () => {
    run(
      Effect.gen(function* () {
        let cheat = true;
        const drawn: string[] = [];
        const Cheat = System.make("Cheat", function* () {
          if (cheat) {
            (yield* World).random.next();
          }
        }).pipe(System.inStage("frame"));
        const After = System.make("After", function* () {
          drawn.push("After");
        }).pipe(System.inStage("frame"));
        // Not checked with verifyFrames: this is found either way.
        const app = yield* App.make({ systems: [Cheat, After, Roll], seed: 5 });
        app.world.spawn(Ball.of({ x: 1, vx: 1 }));
        app.tick(1);
        const before = app.world.hash();
        expect(() => app.frame(0)).toThrow(
          /A draw from world\.random was made while the world is frozen/
        );
        expect(app.world.hash()).toBe(before);
        expect(app.world.frozen).toBe(false);
        // The frame ran to its end first, and the outcome is a defect.
        expect(drawn).toEqual(["After"]);
        const exit = app.frameExit(0);
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
        expect(app.world.hash()).toBe(before);
        // The app is not left in a frame: it ticks, and draws once it behaves.
        app.tick(1);
        cheat = false;
        app.frame(0);
        expect(Exit.isSuccess(app.frameExit(0))).toBe(true);
      })
    );
  });

  it("issues an action as input from outside: logged, applied next tick, replayed without it", () => {
    const Kick = Action.define("fr/Kick", Schema.Struct({ by: Schema.Int }));
    const kick = Action.handler(Kick, function* ({ by }) {
      (yield* Balls).each((ball) => {
        ball.vx += by;
      });
    });
    run(
      Effect.gen(function* () {
        // A button in the picture: pressed in the third frame.
        const Button = System.make("Button", function* () {
          if ((yield* Frame).count === 3) {
            (yield* Action.Actions).enqueue(Kick, { by: 4 });
          }
        }).pipe(System.inStage("frame"));
        const make = (systems: readonly System.System<never, BuiltIn>[]) =>
          Effect.gen(function* () {
            const app = yield* App.make({
              systems,
              handlers: [kick],
              checkpointEvery: 1,
            });
            app.world.spawn(Ball.of({ x: 0, vx: 1 }));
            return app;
          });
        const app = yield* make([Roll, Button]);
        for (let n = 0; n < 5; n++) {
          app.tick(1);
          app.frame(0);
        }
        expect(
          app.world.get(app.world.view(Balls).entities()[0]!, Ball)
        ).toEqual({ x: 1 + 1 + 1 + 5 + 5, vx: 5 });
        expect(
          app.actionLog.filter((entry) => !Action.isCheckpoint(entry))
        ).toEqual([
          { tick: 3, name: "fr/Kick", payload: { by: 4 }, queued: true },
        ]);
        // The replay has no button and draws no frame.
        const headless = yield* make([Roll]);
        App.replay(headless, app.record());
        expect(headless.world.hash()).toBe(app.world.hash());
        // Nor may a frame dispatch: that would change the game there and then.
        let own: App.Any | undefined;
        const Hasty = System.make("Hasty", function* () {
          own?.dispatchByName("fr/Kick", { by: 1 });
        }).pipe(System.inStage("frame"));
        const hasty = yield* make([Hasty]);
        own = hasty;
        expect(() => hasty.frame(0)).toThrow(
          /dispatch\("fr\/Kick"\) was called during the frame stage.*Actions\.enqueue/
        );
      })
    );
  });

  it("refuses a tick, a frame or a save from inside a frame, and a frame from inside a tick", () => {
    run(
      Effect.gen(function* () {
        let inFrame: (() => unknown) | undefined;
        let inTick: (() => unknown) | undefined;
        const drawn: number[] = [];
        const Reenter = System.make("Reenter", function* () {
          drawn.push((yield* Frame).count);
          inFrame?.();
        }).pipe(System.inStage("frame"));
        const InTick = System.make("InTick", function* () {
          inTick?.();
        });
        const app: App.Any = yield* App.make({ systems: [Reenter, InTick] });
        inFrame = () => app.tick(1);
        expect(() => app.frame(0)).toThrow(
          /App\.tick was called from inside a frame/
        );
        inFrame = () => app.frame(0);
        expect(() => app.frame(0)).toThrow(
          /App\.frame was called from inside a frame/
        );
        inFrame = () => app.save();
        expect(() => app.frame(0)).toThrow(/save\(\) was called during/);
        inFrame = undefined;
        inTick = () => app.frame(0);
        drawn.length = 0;
        expect(() => app.tick(1)).toThrow(
          /App\.frame was called from inside a tick/
        );
        // Nothing was drawn in the middle of the tick.
        expect(drawn).toEqual([]);
        inTick = undefined;
        app.tick(1);
        app.frame(0);
      })
    );
  });

  it("keeps real time out of the simulation, and hooks out of the frame stage", () => {
    run(
      Effect.gen(function* () {
        const Peek = System.make("Peek", function* () {
          void (yield* Frame).alpha;
        });
        const app = yield* App.make({ systems: [Peek] });
        expect(() => app.tick(1)).toThrow(
          /Frame was read by a system that runs in the tick.*read Time instead/
        );
      })
    );
    expect(() =>
      run(
        App.make({
          systems: [
            System.make("Splash", function* () {}).pipe(
              System.inStage("frame"),
              State.onEnter(Phase, "paused")
            ),
          ],
        })
      )
    ).toThrow(/System "Splash" is a hook and is in the frame stage/);
  });
});

describe("what the frame stage reads", () => {
  const Bounced = Event.define("fr/Bounced", Schema.Struct({ at: Schema.Int }));

  it("sees every event once, however many ticks ran since the last frame", () => {
    run(
      Effect.gen(function* () {
        const heard: number[] = [];
        const late: number[] = [];
        const Listen = System.make("Listen", function* () {
          for (const { at } of (yield* Bounced).read()) {
            heard.push(at);
          }
        }).pipe(System.inStage("frame"));
        const Late = System.make("Late", function* () {
          if ((yield* Time).tick >= 4) {
            for (const { at } of (yield* Bounced).read()) {
              late.push(at);
            }
          }
        });
        const Emit = System.make("Emit", function* () {
          (yield* Bounced).emit({ at: (yield* Time).tick });
        });
        const app = yield* App.make({ systems: [Late, Emit, Listen] });
        app.tick(1);
        app.frame(0);
        expect(heard).toEqual([1]);
        // Four ticks with no frame between them, as after a hitch.
        for (let n = 0; n < 4; n++) {
          app.tick(1);
        }
        app.frame(0);
        expect(heard).toEqual([1, 2, 3, 4, 5]);
        app.frame(0);
        expect(heard).toEqual([1, 2, 3, 4, 5]);
        // The simulation cannot tell that anything was kept for the frame
        // stage: a system that first reads on tick 4 hears what it would
        // have heard with no frame stage at all.
        const headless = yield* App.make({
          systems: [Late, Emit],
        });
        const without: number[] = [];
        late.length = 0;
        for (let n = 0; n < 5; n++) {
          headless.tick(1);
        }
        without.push(...late);
        expect(without).toEqual([3, 4]);
        late.length = 0;
        const again = yield* App.make({
          systems: [Late, Emit, Listen],
        });
        again.tick(1);
        again.frame(0);
        for (let n = 0; n < 4; n++) {
          again.tick(1);
        }
        expect(late).toEqual(without);
        expect(again.events.pending(Bounced)).toBe(
          headless.events.pending(Bounced)
        );
        // A system that sat ticks out is no different: when it reads
        // again it goes no further back than it could with no frame stage.
        const sat: number[] = [];
        const Sometimes = System.make("Sometimes", function* () {
          for (const { at } of (yield* Bounced).read()) {
            sat.push(at);
          }
        }).pipe(
          System.runIf(Effect.map(Time, ({ tick }) => tick === 1 || tick === 6))
        );
        const runs = [
          [Sometimes, Emit, Listen],
          [Sometimes, Emit],
        ].map((systems) =>
          Effect.gen(function* () {
            sat.length = 0;
            const each = yield* App.make({ systems });
            each.tick(1);
            each.frame(0);
            for (let n = 0; n < 5; n++) {
              each.tick(1);
            }
            return [...sat];
          })
        );
        expect(yield* runs[0]!).toEqual([5]);
        expect(yield* runs[1]!).toEqual([5]);
        // Nor can a save: it holds what the simulation has yet to read, and
        // nothing that was only kept for the frame stage, or of its readers.
        const saves = [again, headless].map((each) => {
          const save = each.save();
          return Exit.isSuccess(save)
            ? readSnapshot(save.value.world).stores
            : undefined;
        });
        expect(saves[0]).toEqual(saves[1]);
        expect(saves[0]).toEqual([
          {
            name: Event.STORE,
            data: [{ name: "fr/Bounced", waiting: [{ at: 5 }], read: {} }],
          },
        ]);
      })
    );
  });

  it("stops keeping events for a frame stage that has stopped running", () => {
    run(
      Effect.gen(function* () {
        const heard: number[] = [];
        const Listen = System.make("Listen", function* () {
          heard.push((yield* Bounced).read().length);
        }).pipe(System.inStage("frame"));
        const Emit = System.make("Emit", function* () {
          (yield* Bounced).emit({ at: (yield* Time).tick });
        });
        const app = yield* App.make({ systems: [Emit, Listen] });
        // A frame stage that keeps running is kept for, however long.
        for (let n = 0; n < 700; n++) {
          app.tick(1);
          app.frame(0);
        }
        for (let n = 0; n < 4; n++) {
          app.tick(1);
        }
        app.frame(0);
        expect(heard.at(-1)).toBe(4);
        heard.length = 0;
        app.tick(1);
        app.frame(0);
        for (let n = 0; n < 500; n++) {
          app.tick(1);
        }
        app.frame(0);
        // All 500 were kept.
        expect(heard).toEqual([1, 500]);
        for (let n = 0; n < 2000; n++) {
          app.tick(1);
        }
        app.frame(0);
        // After 600 ticks without a frame the app stopped keeping them:
        // what is left is what any reader would find.
        expect(heard.at(-1)).toBeLessThan(5);
      })
    );
  });

  it("has a place of its own in what changed, which is not the simulation's and not saved", () => {
    run(
      Effect.gen(function* () {
        const drawn: number[] = [];
        const counted: number[] = [];
        const Draw = System.make("Draw", function* () {
          let rows = 0;
          // Raw columns of what it watches: nothing is written in a frame.
          (yield* Moved).eachChunk((start, end) => {
            rows += end - start;
          });
          drawn.push(rows);
        }).pipe(System.inStage("frame"));
        const Count = System.make("Count", function* () {
          counted.push((yield* Moved).entities().length);
        });
        const Nudge = System.make("Nudge", function* () {
          const { tick } = yield* Time;
          (yield* Balls).each((ball, entity) => {
            if (entity === tick % 3) {
              ball.x += 1;
            }
          });
        });
        const options = {
          systems: [Count, Nudge, Draw],
          checkpointEvery: 1,
        };
        const app = yield* App.make(options);
        for (let n = 0; n < 3; n++) {
          app.world.spawn(Ball.of({ x: n, vx: 0 }));
        }
        app.frame(0);
        app.tick(1);
        app.tick(1);
        app.frame(0);
        app.frame(0);
        // The first frame draws everything; the next, the two that moved.
        expect(drawn).toEqual([3, 2, 0]);
        // The simulation's own reader saw each change once, a tick late.
        expect(counted).toEqual([3, 1]);

        app.tick(1);
        const save = app.save();
        if (Exit.isFailure(save)) {
          throw new Error("the save was refused");
        }
        // The save knows the simulation's reader and not the frame's.
        const visits = readSnapshot(save.value.world).stores.find(
          (store) => store.name === Save.VISITS
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
        const loaded = yield* App.load(read.value, options);
        drawn.length = 0;
        counted.length = 0;
        loaded.frame(0);
        loaded.tick(1);
        // A loaded game has everything still to draw, and its simulation
        // goes on from where it was.
        expect(drawn).toEqual([3]);
        expect(counted).toEqual([1]);
      })
    );
  });

  it("changes nothing: a game drawn every frame is the game that was never drawn", () => {
    run(
      Effect.gen(function* () {
        const Watch = System.make("Watch", function* () {
          let sum = 0;
          (yield* Balls).each((ball) => {
            sum += ball.x;
          });
          (yield* Moved).each(() => {});
          (yield* Bounced).read();
          void (yield* Score).points;
          void (yield* Phase).value;
          void (yield* Random).next();
          void sum;
        }).pipe(System.inStage("frame"));
        const Tally = System.make("Tally", function* () {
          (yield* Score).points += (yield* Bounced).read().length;
          const random = yield* Random;
          (yield* Balls).each((ball) => {
            ball.x += random.next();
          });
          (yield* Bounced).emit({ at: 0 });
        });
        const make = (systems: readonly System.System<never, BuiltIn>[]) =>
          Effect.gen(function* () {
            const app = yield* App.make({
              systems,
              checkpointEvery: 1,
              seed: 3,
              verifyFrames: true,
            });
            for (let n = 0; n < 4; n++) {
              app.world.spawn(Ball.of({ x: n, vx: 1 }));
            }
            return app;
          });
        const drawn = yield* make([Roll, Tally, Watch]);
        const undrawn = yield* make([Roll, Tally]);
        for (let n = 0; n < 20; n++) {
          drawn.tick(1 / 60);
          for (let f = 0; f < n % 3; f++) {
            drawn.frame(f / 3, 0.005);
          }
          undrawn.tick(1 / 60);
          expect(drawn.world.hash()).toBe(undrawn.world.hash());
        }
        expect(drawn.actionLog).toEqual(undrawn.actionLog);
        const saved = [drawn.save(), undrawn.save()].map((save) =>
          Exit.isSuccess(save) ? Save.encode(save.value) : undefined
        );
        expect(saved[0]).toEqual(saved[1]);
      })
    );
  });
});

describe("a frame stage that is checked", () => {
  const Sneak = (how: "raw" | "random" | "none") =>
    System.make("Sneak", function* () {
      if (how === "raw") {
        (yield* Balls).eachChunk((start, end, balls) => {
          for (let i = start; i < end; i++) {
            balls.x[i]! += 1;
          }
        });
      } else if (how === "random") {
        (yield* World).random.next();
      }
    }).pipe(System.inStage("frame"));
  const Honest = System.make("Honest", function* () {
    void (yield* Balls).count();
  }).pipe(System.inStage("frame"));

  it("holds what a system does in place of running to the same, and names that system", () => {
    run(
      Effect.gen(function* () {
        // It does not run, and what it does then writes a raw column.
        const Idle = Honest.pipe(
          System.runIf(Effect.succeed(false)),
          System.otherwise(
            Effect.map(Balls, (balls) => {
              balls.eachChunk((start, end, ball) => {
                for (let i = start; i < end; i++) {
                  ball.x[i] = 99;
                }
              });
            })
          )
        );
        const app = yield* App.make({ systems: [Idle], verifyFrames: true });
        app.world.spawn(Ball.of({ x: 1, vx: 1 }));
        const exit = app.frameExit(0);
        const error = Exit.isFailure(exit)
          ? Cause.squash(exit.cause)
          : undefined;
        expect(error).toBeInstanceOf(App.FrameChangedWorld);
        expect(error).toMatchObject({ system: "Honest" });
      })
    );
  });

  it("finds the two changes that are not stopped where they are made, and names the system", () => {
    for (const how of ["raw", "random"] as const) {
      run(
        Effect.gen(function* () {
          const app = yield* App.make({
            systems: [Honest, Sneak(how), Roll],
            verifyFrames: true,
          });
          app.world.spawn(Ball.of({ x: 1, vx: 1 }));
          app.tick(1);
          const exit = app.frameExit(0.5);
          const error = Exit.isFailure(exit)
            ? Cause.squash(exit.cause)
            : undefined;
          expect(error).toBeInstanceOf(App.FrameChangedWorld);
          expect(error).toMatchObject({ system: "Sneak", frame: 1 });
          expect((error as Error).message).toMatch(
            /after system "Sneak" ran in frame 1.*raw columns of eachChunk.*world\.random/
          );
          // It is a defect: nothing in the error channel to handle.
          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
          // Checked, a draw from the world's generator is laid at the door
          // of the system that made it, and taken back as ever. A write
          // through a raw column is not taken back: #195.
          const before = app.world.hash();
          expect(() => app.frame(0)).toThrow(App.FrameChangedWorld);
          expect(app.world.hash() === before).toBe(how === "random");
        })
      );
    }
  });

  it("passes a frame stage that leaves the world alone, and is off unless asked for", () => {
    run(
      Effect.gen(function* () {
        const checked = yield* App.make({
          systems: [Honest, Sneak("none"), Roll],
          verifyFrames: true,
        });
        checked.world.spawn(Ball.of({ x: 1, vx: 1 }));
        checked.tick(1);
        checked.frame(0);
        // The world a frame is held to is the one it found, not the last one.
        checked.tick(1);
        checked.frame(0.5);
        // Unchecked, the write goes through: it is the game's to avoid.
        const unchecked = yield* App.make({ systems: [Sneak("raw"), Roll] });
        const ball = unchecked.world.spawn(Ball.of({ x: 1, vx: 1 }));
        unchecked.frame(0);
        expect(unchecked.world.get(ball, Ball)!.x).toBe(2);
      })
    );
  });
});
