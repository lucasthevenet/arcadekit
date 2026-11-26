import { assert, describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Data,
  Effect,
  Exit,
  Layer,
  Result,
  Schema,
} from "effect";

import { readSnapshot } from "../src/ecs/index.ts";
import {
  Action,
  App,
  Commands,
  Component,
  Driver,
  Event,
  Field,
  Frame,
  Input,
  Plugin,
  Query,
  Random,
  Replay,
  Save,
  Setting,
  Singleton,
  State,
  System,
  Test,
  Time,
  Timeline,
  World,
} from "../src/index.ts";
import type { Rng } from "../src/index.ts";
import { Session } from "../src/net/index.ts";
import { thrown } from "./checks.ts";

const Ship = Component.define("in/Ship", { x: Field.f32, shots: Field.i32 });
const Ships = Query.all(Ship).pipe(Query.writes(Ship));
const Seen = Query.all(Ship);
const Score = Singleton.define(
  "in/Score",
  { points: Field.i32 },
  { points: 0 }
);
const Phase = State.define("in/Phase", ["playing", "paused"]);

/** The events a save holds waiting, with how far each system had read. */
const waitingIn = (save: Save.Save): unknown =>
  readSnapshot(save.world).stores.find((store) => store.name === Event.STORE)
    ?.data;

const withSource =
  (source: Input.Listener) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provide(effect, Input.layer(source));

/** What a system of the input stage was told, in a form that compares. */
const told = (devices: Input.Sample) => ({
  down: Array.from(devices.down).toSorted(),
  pressed: devices.pressed.toSorted(),
  released: devices.released.toSorted(),
  axes: Object.fromEntries(devices.axes),
  moved: devices.moved.toSorted(),
});

// A game steered with the keyboard: the picture in the world, read in the tick.
const Steer = System.tick("Steer", function* () {
  const keys = yield* Input.Keyboard;
  const { delta } = yield* Time;
  (yield* Ships).each((ship) => {
    if (keys.down("ArrowLeft")) {
      ship.x -= 10 * delta;
    }
    if (keys.down("ArrowRight")) {
      ship.x += 10 * delta;
    }
    if (keys.pressed("Space")) {
      ship.shots += 1;
    }
  });
});
const Flying = Plugin.make("Flying", {
  plugins: [Input.plugin],
  systems: [Steer],
  setup: Effect.map(Commands.spawns(Ship), (commands) => {
    commands.spawn(Ship.of({ x: 0, shots: 0 }));
  }),
});
const ship = Effect.fnUntraced(function* (app: App.Any) {
  let found = { x: Number.NaN, shots: Number.NaN };
  (yield* app.read(Seen)).each((one) => {
    found = { x: one.x, shots: one.shots };
  });
  return found;
});
/** A game that begins with a ship, and no way to steer it. */
/**
 * The tick's generator, which is the world's, kept by a plugin's layer as a
 * service of its own: how a frame or input system could draw from it.
 */
class Dice extends Context.Service<Dice, Rng>()("in/Dice") {}
const Kept = Plugin.make("in/Kept", {
  layer: Layer.effect(Dice, Effect.service(Random)),
});

const Docked = Plugin.make("in/Docked", {
  setup: Effect.map(Commands.spawns(Ship), (commands) => {
    commands.spawn(Ship.of({ x: 1, shots: 0 }));
  }),
});
/** A point, given from outside the game. */
const Award = Action.define("in/Award", Schema.Struct({}));
const award = Action.handler(Award, function* () {
  (yield* Score.writes).points += 1;
});
const hashOf = Effect.fnUntraced(function* (app: App.Any) {
  return (yield* app.read(World)).hash();
});
const pointsOf = Effect.fnUntraced(function* (app: App.Any) {
  return (yield* app.read(Score)).points;
});
const reports = (app: App.Any): unknown[] =>
  app.actionLog
    .filter(
      (entry): entry is Action.Logged =>
        !Action.isHashCheck(entry) && entry.name === "arcadekit/Input.Report"
    )
    .map((entry) => entry.payload);

describe("the input stage", () => {
  it.effect(
    "runs when whoever steps the app runs it, in order, and never in a tick or a frame",
    () =>
      Effect.gen(function* () {
        const ran: string[] = [];
        const note = (name: string, stage: System.Stage) => {
          const body = function* () {
            ran.push(name);
          };
          if (stage === "input") {
            return System.input(name, body);
          }
          if (stage === "frame") {
            return System.frame(name, body);
          }
          if (stage === "preFrame" || stage === "postFrame") {
            return System.frame(name, body).pipe(System.inStage(stage));
          }
          if (stage === "preUpdate" || stage === "postUpdate") {
            return System.tick(name, body).pipe(System.inStage(stage));
          }
          return System.tick(name, body);
        };
        const Second = note("Second", "input");
        const First = note("First", "input");
        const Sometimes = note("Sometimes", "input").pipe(
          System.runIf(State.is(Phase, "paused"))
        );
        const Pause = Action.define("in/Pause", Schema.Struct({}));
        const pause = Action.handler(Pause, function* () {
          (yield* Phase.sets).set("paused");
        });
        const app = yield* App.make(
          App.define({
            systems: [
              First,
              note("Tick", "update"),
              Second,
              note("Draw", "frame"),
              Sometimes,
            ],
            handlers: [pause],
          })
        );
        expect(app.inputOrder).toEqual(["First", "Second", "Sometimes"]);
        expect(app.systemOrder).toEqual(["Tick"]);
        expect(app.frameOrder).toEqual(["Draw"]);
        // A tick reads no device, and a frame doesn't either.
        yield* app.tick(1);
        expect(Exit.isSuccess(yield* Effect.exit(app.tick(1)))).toBe(true);
        yield* app.frame();
        expect(ran).toEqual(["Tick", "Tick", "Draw"]);
        // Whoever steps the app runs it before a tick, as a driver does.
        ran.length = 0;
        yield* app.input();
        yield* app.tick(1);
        yield* app.tick(1);
        expect(ran).toEqual(["First", "Second", "Tick", "Tick"]);
        // A condition is asked there as anywhere.
        yield* app.dispatch(Pause, {});
        yield* app.tick(1);
        ran.length = 0;
        expect(Exit.isSuccess(yield* Effect.exit(app.input()))).toBe(true);
        expect(ran).toEqual(["First", "Second", "Sometimes"]);
        // An app with no input stage is driven as before.
        const plain = yield* App.make(
          App.define({ systems: [note("Other", "update")] })
        );
        expect(plain.inputOrder).toEqual([]);
        yield* plain.input();
      })
  );

  it.effect(
    "is told what the devices say: one sample for every system of a run, and a new one the next",
    () =>
      Effect.gen(function* () {
        const source = Input.makeManualSource();
        yield* Effect.gen(function* () {
          const seen: unknown[] = [];
          const A = System.input("A", function* () {
            seen.push(told(yield* Input.Devices));
          });
          const B = System.input("B", function* () {
            // Pressed while the stage runs: not in this run's sample.
            source.press("KeyZ");
            seen.push(told(yield* Input.Devices));
          });
          const app = yield* App.make(App.define({ systems: [A, B] }));
          source.press("KeyA");
          source.tap("Space");
          source.move(Input.pointerX, 12.5);
          yield* app.input();
          const first = {
            down: ["KeyA"],
            pressed: ["KeyA", "Space"],
            released: ["Space"],
            axes: { PointerX: 12.5 },
            moved: ["PointerX"],
          };
          expect(seen).toEqual([first, first]);
          source.release("KeyA");
          yield* app.input();
          const second = {
            down: ["KeyZ"],
            pressed: ["KeyZ"],
            released: ["KeyA"],
            axes: { PointerX: 12.5 },
            moved: [],
          };
          expect(seen.slice(2)).toEqual([second, second]);
        }).pipe(withSource(source));
      })
  );

  it.effect("has no devices unless a source is provided", () =>
    Effect.gen(function* () {
      const seen: unknown[] = [];
      const A = System.input("A", function* () {
        seen.push(told(yield* Input.Devices));
      });
      const app = yield* App.make(App.define({ systems: [A] }));
      yield* app.input();
      expect(seen).toEqual([
        { down: [], pressed: [], released: [], axes: {}, moved: [] },
      ]);
    })
  );

  it.effect("does not read the devices when no system would hear of them", () =>
    Effect.gen(function* () {
      let samples = 0;
      const inner = Input.makeManualSource();
      const source: Input.Listener = {
        sample() {
          samples++;
          return inner.sample();
        },
      };
      yield* Effect.gen(function* () {
        const Tick = System.tick("Tick", function* () {});
        const app = yield* App.make(App.define({ systems: [Tick] }));
        yield* app.input();
        yield* app.tick(1);
        expect(samples).toBe(0);
        const Listen = System.input("Listen", function* () {
          yield* Input.Devices;
        });
        const listening = yield* App.make(App.define({ systems: [Listen] }));
        yield* listening.input();
        yield* listening.input();
        expect(samples).toBe(2);
      }).pipe(withSource(source));
    })
  );

  it("keeps the devices from the simulation and from what draws it", () => {
    System.tick(
      "Peek",
      // @ts-expect-error the devices are the input stage's
      function* () {
        return (yield* Input.Devices).down.size > 0 ? undefined : undefined;
      }
    );
    System.frame(
      "PeekFrame",
      // @ts-expect-error the devices are the input stage's
      function* () {
        return (yield* Input.Devices).down.size > 0 ? undefined : undefined;
      }
    );
    System.input(
      "Blink",
      // @ts-expect-error the input stage has no frame
      function* () {
        return (yield* Frame).alpha > 0 ? undefined : undefined;
      }
    );
    expect(System.input("Ok", function* () {}).stage).toBe("input");
  });

  it.effect(
    "cannot change the game: whatever would throws, and names what did",
    () =>
      Effect.gen(function* () {
        const Bump = Action.define("in/Bump", Schema.Struct({}));
        const bump = Action.handler(Bump, function* () {
          (yield* Score.writes).points += 1;
        });
        const attempts: Record<string, Effect.Effect<unknown, never, Dice>> = {
          "A draw from world.random": Effect.map(Effect.service(Dice), (dice) =>
            dice.next()
          ),
        };
        for (const [what, attempt] of Object.entries(attempts)) {
          const Vandal = System.input("Vandal", function* () {
            yield* attempt;
          });
          const app = yield* App.make(
            App.define({
              plugins: [Docked, Kept],
              handlers: [bump],
              systems: [Vandal],
            }),
            { hashEvery: 1, seed: 3 }
          );
          yield* app.tick(1);
          const before = yield* hashOf(app);
          expect(yield* thrown(app.input()), what).toThrow(what);
          expect(yield* hashOf(app), what).toBe(before);
          // No event waits to be read, and no command to be applied: a save
          // would be refused for one.
          expect((yield* app.inspect()).stores, what).not.toHaveProperty([
            Event.STORE,
          ]);
          expect(Exit.isSuccess(yield* Effect.exit(Save.make(app))), what).toBe(
            true
          );
          // And the app is not left frozen, or in the middle of the stage.
          expect(
            Exit.isSuccess(yield* Effect.exit(app.dispatch(Bump, {}))),
            what
          ).toBe(true);
          expect(yield* pointsOf(app), what).toBe(1);
          yield* app.tick(1);
          expect(Exit.isFailure(yield* Effect.exit(app.input())), what).toBe(
            true
          );
        }
        // Nor can it be reached around: the app says where it is.
        {
          let app: App.App<never, typeof bump> | undefined;
          let reach: Effect.Effect<unknown> = Effect.void;
          const Reach = System.input("Reach", function* () {
            yield* reach;
          });
          app = yield* App.make(
            App.define({ handlers: [bump], systems: [Reach] })
          );
          const made = app;
          reach = Effect.orDie(made.dispatch(Bump, {}));
          expect(yield* thrown(made.input())).toThrow(
            /dispatch\("in\/Bump"\) was called during the input stage/
          );
          reach = made.tick(1);
          expect(yield* thrown(made.input())).toThrow(
            /App\.tick was called from inside a run of the input stage/
          );
          reach = made.input();
          expect(yield* thrown(made.input())).toThrow(
            /App\.input was called from inside a run of the input stage/
          );
          reach = made.frame();
          expect(yield* thrown(made.input())).toThrow(
            /App\.frame was called from inside a run of the input stage/
          );
          reach = Effect.orDie(Save.make(made));
          expect(yield* thrown(made.input())).toThrow(
            /Save\.make\(\) was called during/
          );
          reach = Effect.void;
          yield* made.input();
          expect(yield* pointsOf(made)).toBe(0);
          // And the input stage is not run from inside a tick.
          let nested: App.App | undefined;
          const Nested = System.tick("Nested", function* () {
            if (nested !== undefined) {
              yield* nested.input();
            }
          });
          nested = yield* App.make(App.define({ systems: [Nested, Reach] }));
          expect(yield* thrown(nested!.tick(1))).toThrow(
            /App\.input was called from inside a tick/
          );
        }
      })
  );

  it.effect(
    "is checked by verifyFrames, which names the system that drew from the world's generator",
    () =>
      Effect.gen(function* () {
        const Scribble = System.input("Scribble", function* () {
          (yield* Dice).next();
        });
        const app = yield* App.make(
          App.define({ plugins: [Docked, Kept], systems: [Scribble] }),
          { verifyFrames: true }
        );
        const exit = yield* Effect.exit(app.input());
        expect(Exit.isFailure(exit)).toBe(true);
        const error = Result.getOrThrow(Exit.findDefect(exit));
        assert.instanceOf(error, App.FrameChangedWorld);
        expect(error.stage).toBe("input");
        expect(error.system).toBe("Scribble");
        expect(error.message).toMatch(/^The input stage changed the world/);
        expect(error.message).toMatch(/reads the devices before a tick/);
        // A frame system that does the same is still called a frame system.
        const Smudge = System.frame("Smudge", function* () {
          (yield* Dice).next();
        });
        const drawn = yield* App.make(
          App.define({ plugins: [Docked, Kept], systems: [Smudge] }),
          { verifyFrames: true }
        );
        const smudged = Result.getOrThrow(
          Exit.findDefect(yield* Effect.exit(drawn.frame(0)))
        );
        assert.instanceOf(smudged, App.FrameChangedWorld);
        expect(smudged.stage).toBe("frame");
        expect(smudged.message).toMatch(
          /^The frame stage changed the world: its hash was not the same after system "Smudge" ran in frame 1 as before/
        );
      })
  );

  it.effect(
    "refuses with verifyFrames a write through a raw column, where it is made, and puts it back",
    () =>
      Effect.gen(function* () {
        const Scribble = System.input("Scribble", function* () {
          (yield* Seen).eachChunk((start, end, ships) => {
            for (let i = start; i < end; i++) {
              // @ts-expect-error a read query's columns are not assigned
              ships.x[i] = 99;
            }
          });
        });
        const app = yield* App.make(
          App.define({ plugins: [Docked], systems: [Scribble] }),
          { verifyFrames: true }
        );
        const before = yield* hashOf(app);
        const exit = yield* Effect.exit(app.input());
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(
          new Error(
            'eachChunk() wrote "in/Ship.x", which the query only reads, through its raw column. No change query would see the write, and no refusal would undo it, so it has been put back. Name "in/Ship" in Query.writes to write it, or write it with each().'
          )
        );
        expect(yield* hashOf(app)).toBe(before);
      })
  );

  it.effect(
    "is not tripped by verifyFrames when a system between ticks issues an action, which the world's hash still covers",
    () =>
      Effect.gen(function* () {
        const Bump = Action.define(
          "in/VerifiedBump",
          Schema.Struct({ by: Schema.Int })
        );
        const bump = Action.handler(Bump, function* ({ by }) {
          (yield* Score.writes).points += by;
        });
        const Press = System.input("Press", function* () {
          (yield* Action.Actions).enqueue(Bump, { by: 2 });
        });
        const Point = System.frame("Point", function* () {
          (yield* Action.Actions).enqueue(Bump, { by: 3 });
        });
        const app = yield* App.make(
          App.define({ handlers: [bump], systems: [Press, Point] }),
          { verifyFrames: true }
        );
        const before = yield* hashOf(app);
        expect(Exit.isSuccess(yield* Effect.exit(app.input()))).toBe(true);
        expect(Exit.isSuccess(yield* Effect.exit(app.frame(0)))).toBe(true);
        expect(yield* hashOf(app)).not.toBe(before);
        yield* app.tick(1);
        expect(yield* pointsOf(app)).toBe(5);
      })
  );

  it.effect(
    "issues actions that are logged as input from outside and applied at the start of the next tick",
    () =>
      Effect.gen(function* () {
        const source = Input.makeManualSource();
        yield* Effect.gen(function* () {
          const Bump = Action.define(
            "in/Bump",
            Schema.Struct({ by: Schema.Int })
          );
          const bump = Action.handler(Bump, function* ({ by }) {
            (yield* Score.writes).points += by;
          });
          const Press = System.input("Press", function* () {
            const devices = yield* Input.Devices;
            if (devices.pressed.includes("Enter")) {
              (yield* Action.Actions).enqueue(Bump, { by: 5 });
            }
          });
          const seen: number[] = [];
          const Look = System.tick("Look", function* () {
            seen.push((yield* Score).points);
          });
          const app = yield* App.make(
            App.define({ handlers: [bump], systems: [Press, Look] }),
            { hashEvery: 0 }
          );
          source.press("Enter");
          yield* app.input();
          expect(yield* pointsOf(app)).toBe(0);
          expect(app.actionLog).toEqual([
            { tick: 0, name: "in/Bump", payload: { by: 5 }, queued: true },
          ]);
          yield* app.tick(1);
          expect(seen).toEqual([5]);
          // Held is not pressed again.
          yield* app.input();
          yield* app.tick(1);
          expect(seen).toEqual([5, 5]);
          expect(app.actionLog.length).toBe(1);
        }).pipe(withSource(source));
      })
  );

  it.effect(
    "is run by the fixed step just before each tick, and not at all when no tick is due",
    () =>
      Effect.gen(function* () {
        const source = Input.makeManualSource();
        yield* Effect.gen(function* () {
          const order: string[] = [];
          const Listen = System.input("Listen", function* () {
            order.push(`input ${told(yield* Input.Devices).pressed.join("+")}`);
          });
          const Tick = System.tick("Tick", function* () {
            order.push(`tick ${(yield* Time).tick}`);
          });
          const Draw = System.frame("Draw", function* () {
            order.push("frame");
          });
          const app = yield* App.make(
            App.define({ systems: [Listen, Tick, Draw] })
          );
          const step = Driver.fixedStep(app, { hz: 10 });
          // Frames of 40 ms against ticks of 100 ms.
          source.press("KeyA");
          yield* step(0.04);
          source.tap("KeyB");
          yield* step(0.04);
          expect(order).toEqual(["frame", "frame"]);
          // The tick that comes due hears what was pressed in every frame since.
          yield* step(0.04);
          expect(order.slice(2)).toEqual([
            "input KeyA+KeyB",
            "tick 1",
            "frame",
          ]);
          // A long frame reads the devices before each of its ticks.
          order.length = 0;
          source.press("KeyC");
          yield* step(0.2);
          expect(order).toEqual([
            "input KeyC",
            "tick 2",
            "input ",
            "tick 3",
            "frame",
          ]);
        }).pipe(withSource(source));
      })
  );

  it.effect(
    "reads events and changes from a place of its own, which is not saved",
    () =>
      Effect.gen(function* () {
        const Landed = Event.define(
          "in/Landed",
          Schema.Struct({ at: Schema.Int })
        );
        const Land = System.tick("Land", function* () {
          (yield* Landed.emits).emit({ at: (yield* Time).tick });
        });
        const heard: number[] = [];
        const also: number[] = [];
        const drawn: number[] = [];
        const hear = (
          name: string,
          into: number[],
          stage: "input" | "frame"
        ) => {
          const body = function* () {
            for (const landed of (yield* Landed).read()) {
              into.push(landed.at);
            }
          };
          return stage === "input"
            ? System.input(name, body)
            : System.frame(name, body);
        };
        const app = yield* App.make(
          App.define({
            systems: [
              Land,
              hear("Hear", heard, "input"),
              hear("Also", also, "input"),
            ],
          })
        );
        const plain = yield* App.make(App.define({ systems: [Land] }));
        for (let i = 0; i < 3; i++) {
          yield* app.input();
          yield* app.tick(1);
          yield* plain.tick(1);
        }
        // Each system of the stage hears each event, once.
        expect(heard).toEqual([1, 2]);
        expect(also).toEqual([1, 2]);
        // What draws the game still hears every event of a frame of
        // several ticks: the input stage ran before each, and is not it.
        const both = yield* App.make(
          App.define({
            systems: [
              Land,
              hear("Hear", [], "input"),
              hear("Draw", drawn, "frame"),
            ],
          })
        );
        const step = Driver.fixedStep(both, { hz: 10 });
        yield* step(0.1);
        yield* step(0.3);
        expect(drawn).toEqual([1, 2, 3, 4]);
        // The game cannot tell that its devices are read.
        expect(yield* hashOf(app)).toBe(yield* hashOf(plain));
        const save = yield* Effect.exit(Save.make(app));
        const bare = yield* Effect.exit(Save.make(plain));
        assert(Exit.isSuccess(save) && Exit.isSuccess(bare));
        expect(waitingIn(save.value)).toEqual(waitingIn(bare.value));
      })
  );

  it.effect(
    "hears what a tick's actions emitted, and that an action it issued was refused",
    () =>
      Effect.gen(function* () {
        class TooMuch extends Schema.TaggedError<TooMuch>()("TooMuch", {}) {}
        const Done = Event.define("in/Done", Schema.Struct({ by: Schema.Int }));
        const Try = Action.define("in/Try", Schema.Struct({ by: Schema.Int }), {
          error: TooMuch,
        });
        const attempt = Action.handler(Try, function* ({ by }) {
          if (by > 5) {
            return yield* TooMuch.make({});
          }
          (yield* Done.emits).emit({ by });
        });
        const hear = (
          name: string,
          stage: "input" | "frame",
          done: number[],
          refused: string[]
        ) => {
          const body = function* () {
            for (const event of (yield* Done).read()) {
              done.push(event.by);
            }
            for (const event of (yield* Action.Rejected).read()) {
              refused.push(`${event.action} ${event.error._tag}`);
            }
          };
          return stage === "input"
            ? System.input(name, body)
            : System.frame(name, body);
        };
        {
          // An app with an input stage and no frame stage; one with both;
          // and one with neither, which is the game they must not change.
          const heard: number[] = [];
          const refused: string[] = [];
          const both: number[] = [];
          const drawn: number[] = [];
          const drawnRefused: string[] = [];
          const alone = yield* App.make(
            App.define({
              handlers: [attempt],
              systems: [hear("Hear", "input", heard, refused)],
            })
          );
          const together = yield* App.make(
            App.define({
              handlers: [attempt],
              systems: [
                hear("Hear", "input", both, []),
                hear("Draw", "frame", drawn, drawnRefused),
              ],
            })
          );
          const bare = yield* App.make(App.define({ handlers: [attempt] }));
          // And one with a frame stage and no input stage.
          const onlyDrawn: number[] = [];
          const shown = yield* App.make(
            App.define({
              handlers: [attempt],
              systems: [hear("Draw", "frame", onlyDrawn, [])],
            })
          );
          for (const by of [1, 9, 3]) {
            for (const app of [alone, together, bare, shown]) {
              // What the action emits, it emits before the tick's systems
              // run: the oldest events of the tick.
              yield* app.input();
              yield* app.enqueue(Try, { by });
              yield* app.tick(1);
              yield* app.frame();
            }
          }
          yield* alone.input();
          yield* together.input();
          // Each event once, the first tick's among them, and the refusal.
          expect(heard).toEqual([1, 3]);
          expect(refused).toEqual(["in/Try TooMuch"]);
          expect(both).toEqual([1, 3]);
          expect(drawn).toEqual([1, 3]);
          expect(drawnRefused).toEqual(["in/Try TooMuch"]);
          expect(onlyDrawn).toEqual([1, 3]);
          // And the game cannot tell that anyone was listening.
          expect(yield* hashOf(alone)).toBe(yield* hashOf(bare));
          const saves = yield* Effect.forEach([alone, together, bare], (app) =>
            Effect.exit(Save.make(app))
          );
          const events = saves.map((save) => {
            assert(Exit.isSuccess(save));
            return waitingIn(save.value);
          });
          expect(events[0]).toEqual(events[2]);
          expect(events[1]).toEqual(events[2]);
          // Heard, they are kept no longer.
          for (let i = 0; i < 3; i++) {
            yield* alone.input();
            yield* alone.tick(1);
          }
          expect((yield* alone.inspect()).stores).not.toHaveProperty([
            Event.STORE,
            Done.name,
          ]);
          expect(heard).toEqual([1, 3]);
        }
      })
  );

  it.effect(
    "keeps an event until the stages have had their chance at it, and no longer",
    () =>
      Effect.gen(function* () {
        const Done = Event.define("in/Once", Schema.Struct({ at: Schema.Int }));
        const Emit = Action.define("in/EmitOnce", Schema.Struct({}));
        const emit = Action.handler(Emit, function* () {
          (yield* Done.emits).emit({ at: (yield* Time).tick + 1 });
        });
        // A system that first listens late hears what is still kept: only
        // what its stage has not yet had its chance at.
        const late = (
          stage: "input" | "frame",
          listening: () => boolean,
          heard: number[]
        ) => {
          const body = function* () {
            if (listening()) {
              for (const event of (yield* Done).read()) {
                heard.push(event.at);
              }
            }
          };
          return stage === "input"
            ? System.input("Late", body)
            : System.frame("Late", body);
        };
        for (const stage of ["input", "frame"] as const) {
          let listening = false;
          const heard: number[] = [];
          const app = yield* App.make(
            App.define({
              handlers: [emit],
              systems: [late(stage, () => listening, heard)],
            })
          );
          for (let tick = 1; tick <= 6; tick++) {
            listening = tick === 6;
            yield* app.input();
            yield* app.enqueue(Emit, {});
            yield* app.tick(1);
            yield* app.frame();
          }
          yield* app.input();
          // The input stage runs before a tick, so what it has not had
          // its chance at is the tick before; the frame stage runs after.
          expect(heard, stage).toEqual(stage === "input" ? [5, 6] : [6]);
        }
      })
  );

  it.effect(
    "keeps events for a stage that is late, and stops for one that is never run, as a replay never runs it",
    () =>
      Effect.gen(function* () {
        const Done = Event.define("in/Kept", Schema.Struct({}));
        const Emit = Action.define("in/Emit", Schema.Struct({}));
        const emit = Action.handler(Emit, function* () {
          (yield* Done.emits).emit({});
        });
        let heard = 0;
        const Hear = System.input("Hear", function* () {
          heard += (yield* Done).read().length;
        });
        const ticked = function* (ticks: number) {
          const app = yield* App.make(
            App.define({ handlers: [emit], systems: [Hear] })
          );
          for (let i = 0; i < ticks; i++) {
            yield* app.enqueue(Emit, {});
            yield* app.tick(1);
          }
          return app;
        };
        // Late by a hundred ticks: every one of their events is there.
        const late = yield* ticked(100);
        yield* late.input();
        expect(heard).toBe(100);
        // Never run in seven hundred, as in a replay: the app has taken
        // the stage to be gone, and keeps nothing for it.
        heard = 0;
        const gone = yield* ticked(700);
        yield* gone.input();
        expect(heard).toBe(0);
        // Run again, it hears again from then on.
        for (let i = 0; i < 3; i++) {
          yield* gone.enqueue(Emit, {});
          yield* gone.tick(1);
          yield* gone.input();
        }
        expect(heard).toBe(3);
      })
  );

  it.effect(
    "is not run by a tick: a game stepped by hand hears its keys when it runs the stage",
    () =>
      Effect.gen(function* () {
        const source = Input.makeManualSource();
        yield* Effect.gen(function* () {
          const app = yield* App.make(App.define({ plugins: [Flying] }), {
            hashEvery: 0,
          });
          // With no `app.input()`, the key is not heard.
          source.press("ArrowRight");
          yield* app.tick(1);
          expect((yield* ship(app)).x).toBe(0);
          expect(reports(app)).toEqual([]);
          yield* app.input();
          yield* app.tick(1);
          yield* app.tick(1);
          expect((yield* ship(app)).x).toBe(20);
          source.release("ArrowRight");
          source.tap("Space");
          yield* app.input();
          yield* app.tick(1);
          expect(yield* ship(app)).toEqual({ x: 20, shots: 1 });
          // Each run of the stage read the devices once, and reported what
          // had changed.
          expect(reports(app)).toEqual([
            { down: ["ArrowRight"] },
            { up: ["ArrowRight"], tapped: ["Space"] },
          ]);
          // A driver runs the stage before each tick: one report for one
          // change.
          const step = Driver.fixedStep(app, { hz: 10 });
          source.press("ArrowLeft");
          yield* step(0.3);
          expect(app.time.tick).toBe(7);
          expect(reports(app).slice(2)).toEqual([{ down: ["ArrowLeft"] }]);
          expect((yield* ship(app)).x).toBeCloseTo(17, 5);
        }).pipe(withSource(source));
      })
  );

  it.effect(
    "fails on its own: whoever ran it is told, and a tick runs without it",
    () =>
      Effect.gen(function* () {
        class NoKeyboard extends Data.TaggedError("NoKeyboard")<{}> {}
        let broken = true;
        let ran = 0;
        const Read = System.input("Read", function* () {
          ran++;
          if (broken) {
            return yield* new NoKeyboard();
          }
        });
        let ticked = 0;
        const Tick = System.tick("Tick", function* () {
          ticked++;
        });
        const app = yield* App.make(App.define({ systems: [Read, Tick] }));
        const exit = yield* Effect.exit(app.input());
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(
          NoKeyboard
        );
        expect(yield* thrown(app.input())).toThrow(NoKeyboard);
        expect([ran, ticked, app.time.tick]).toEqual([2, 0, 0]);
        yield* app.tick(1);
        expect([ran, ticked, app.time.tick]).toEqual([2, 1, 1]);
        broken = false;
        yield* app.input();
        yield* app.tick(1);
        expect([ran, ticked, app.time.tick]).toEqual([3, 2, 2]);
      })
  );

  it.effect(
    "is not run by a replay, whatever the devices of the machine it is replayed on say",
    () =>
      Effect.gen(function* () {
        const source = Input.makeManualSource();
        let recording: Replay.Recording | undefined;
        let hash = 0;
        yield* Effect.gen(function* () {
          const app = yield* App.make(App.define({ plugins: [Flying] }), {
            hashEvery: 1,
          });
          source.press("ArrowRight");
          yield* app.input();
          yield* app.tick(1);
          yield* app.tick(1);
          recording = yield* Replay.record(app);
          hash = yield* hashOf(app);
          expect((yield* ship(app)).x).toBe(20);
        }).pipe(withSource(source));
        // Replayed where another key is held, and a third is pressed.
        const here = Input.makeManualSource();
        here.press("ArrowLeft");
        here.tap("Space");
        yield* Effect.gen(function* () {
          const again = yield* Replay.verify(
            recording!,
            App.define({ plugins: [Flying] }),
            { hashEvery: 1 }
          );
          expect(yield* hashOf(again)).toBe(hash);
          expect(yield* ship(again)).toEqual({ x: 20, shots: 0 });
          expect(reports(again)).toEqual([{ down: ["ArrowRight"] }]);
          // Played on from there, by hand, it hears the machine it is on.
          yield* again.input();
          yield* again.tick(1);
          expect((yield* ship(again)).shots).toBe(1);
        }).pipe(withSource(here));
      })
  );

  it.effect(
    "gives a system's failure back typed, and a stopped app runs none of it",
    () =>
      Effect.gen(function* () {
        class NoKeyboard extends Data.TaggedError("NoKeyboard")<{}> {}
        const Fail = System.input("Fail", function* () {
          return yield* new NoKeyboard();
        });
        const app = yield* App.make(
          App.define({ systems: [Fail], handlers: [award] })
        );
        const exit = yield* Effect.exit(app.input());
        expect(Exit.isFailure(exit)).toBe(true);
        expect(
          Cause.squash((exit as Exit.Failure<void, NoKeyboard>).cause)
        ).toEqual(new NoKeyboard());
        expect(yield* thrown(app.input())).toThrow(NoKeyboard);
        // The world is not left frozen: a point can still be given.
        expect(
          Exit.isSuccess(yield* Effect.exit(app.dispatch(Award, {})))
        ).toBe(true);
        expect(yield* pointsOf(app)).toBe(1);
        // A system that waits has not finished within the stage.
        const Wait = System.input("Wait", function* () {
          yield* Effect.never;
        });
        const waiting = yield* App.make(
          App.define({ systems: [Wait], handlers: [award] })
        );
        expect(yield* thrown(waiting.input())).toThrow(
          /System "Wait" did not finish within the input stage/
        );
        expect(
          Exit.isSuccess(yield* Effect.exit(waiting.dispatch(Award, {})))
        ).toBe(true);
        expect(yield* pointsOf(waiting)).toBe(1);
      })
  );

  it("refuses a hook, which runs when a tick enters a state", () => {
    const hook = State.onEnter(Phase, "paused", "Hook", function* () {});
    expect(hook.stage).toBe("update");
    expect(hook.trigger?.on).toBe("enter");
  });

  it.effect(
    "draws its random numbers from a generator that is not the world's",
    () =>
      Effect.gen(function* () {
        const drawn: number[] = [];
        const Jitter = System.input("Jitter", function* () {
          drawn.push((yield* Random).next());
        });
        const app = yield* App.make(App.define({ systems: [Jitter] }), {
          seed: 5,
        });
        const before = yield* hashOf(app);
        yield* app.input();
        yield* app.input();
        expect(new Set(drawn).size).toBe(2);
        // The hash holds the state of the world's generator.
        expect(yield* hashOf(app)).toBe(before);
      })
  );
});

describe("the picture of the devices in the world", () => {
  it("is what Input.plugin provides: a game that reads it and leaves the plugin out does not compile", () => {
    const Press = Action.define("in/Press", Schema.Struct({}));
    const reads = [
      System.tick("in/Keys", function* () {
        (yield* Input.Keyboard).down("Space");
      }),
      System.tick("in/Point", function* () {
        void (yield* Input.Pointer).x;
      }),
      System.frame("in/Pad", function* () {
        (yield* Input.Gamepads)(1).axis(0);
      }),
    ] as const;
    const press = Action.handler(Press, function* () {
      (yield* Input.Keyboard).pressed("Space");
    });
    for (const system of reads) {
      expectTypeOf(App.make(App.define({ systems: [system] }))).not.toExtend<
        Effect.Effect<unknown, never>
      >();
      expectTypeOf(
        App.make(App.define({ plugins: [Input.plugin], systems: [system] }))
      ).toExtend<Effect.Effect<unknown, never>>();
    }
    expectTypeOf(App.make(App.define({ handlers: [press] }))).not.toExtend<
      Effect.Effect<unknown, never>
    >();
    expectTypeOf(
      App.make(App.define({ plugins: [Input.plugin], handlers: [press] }))
    ).toExtend<Effect.Effect<unknown, never>>();
  });

  it.effect(
    "says what is held, and what went down or up in this tick, the same to every system",
    () =>
      Effect.gen(function* () {
        const source = Input.makeManualSource();
        yield* Effect.gen(function* () {
          const seen: string[] = [];
          const look = (name: string) =>
            System.tick(name, function* () {
              const keys = yield* Input.Keyboard;
              seen.push(
                `${name} ${(yield* Time).tick}:${keys.down("KeyA") ? " down" : ""}${keys.pressed("KeyA") ? " pressed" : ""}${keys.released("KeyA") ? " released" : ""}`
              );
            });
          const app = yield* App.make(
            App.define({
              plugins: [Input.plugin],
              systems: [look("First"), look("Second")],
            })
          );
          const step = Effect.fnUntraced(function* () {
            yield* app.input();
            yield* app.tick(1);
          });
          yield* step();
          source.press("KeyA");
          yield* step();
          yield* step();
          source.release("KeyA");
          yield* step();
          yield* step();
          expect(seen).toEqual([
            "First 1:",
            "Second 1:",
            "First 2: down pressed",
            "Second 2: down pressed",
            "First 3: down",
            "Second 3: down",
            "First 4: released",
            "Second 4: released",
            "First 5:",
            "Second 5:",
          ]);
          // A key that went down and up between two ticks was pressed, and
          // let go, and is not held.
          seen.length = 0;
          source.tap("KeyA");
          yield* step();
          yield* step();
          expect(seen).toEqual([
            "First 6: pressed released",
            "Second 6: pressed released",
            "First 7:",
            "Second 7:",
          ]);
          // So was one that went down in one frame and up in the next, with
          // no tick between.
          seen.length = 0;
          source.press("KeyA");
          yield* app.input();
          source.release("KeyA");
          yield* app.input();
          yield* app.tick(1);
          yield* app.tick(1);
          expect(seen).toEqual([
            "First 8: pressed released",
            "Second 8: pressed released",
            "First 9:",
            "Second 9:",
          ]);
          // A key let go and pressed again at once: held, and pressed anew.
          source.press("KeyA");
          yield* step();
          source.release("KeyA");
          yield* app.input();
          source.press("KeyA");
          yield* app.input();
          seen.length = 0;
          yield* app.tick(1);
          expect(seen[0]).toBe("First 11: down pressed released");
          // A held key let go and pressed again between two readings of the
          // devices, with no tick between: the same. It went up, it went
          // down, and it is held.
          source.release("KeyA");
          source.press("KeyA");
          seen.length = 0;
          yield* step();
          yield* step();
          expect(seen).toEqual([
            "First 12: down pressed released",
            "Second 12: down pressed released",
            "First 13: down",
            "Second 13: down",
          ]);
          expect(reports(app).at(-1)).toEqual({ up: ["KeyA"], down: ["KeyA"] });
          // A held key let go, pressed and let go again between two ticks:
          // it went up, it was pressed, and it is not held.
          source.release("KeyA");
          source.tap("KeyA");
          seen.length = 0;
          yield* step();
          yield* step();
          expect(seen).toEqual([
            "First 14: pressed released",
            "Second 14: pressed released",
            "First 15:",
            "Second 15:",
          ]);
          expect(reports(app).at(-1)).toEqual({
            up: ["KeyA"],
            tapped: ["KeyA"],
          });
          // Read twice with no tick between, what did not change is said once.
          const said = reports(app).length;
          source.move(Input.pointerX, 5);
          source.press("KeyB");
          yield* app.input();
          yield* app.input();
          yield* app.input();
          expect(reports(app).slice(said)).toEqual([
            { down: ["KeyB"], axes: { PointerX: 5 } },
          ]);
        }).pipe(withSource(source));
      })
  );

  it.effect("has the pointer and the gamepads, each by its own name", () =>
    Effect.gen(function* () {
      const source = Input.makeManualSource();
      yield* Effect.gen(function* () {
        let seen: unknown;
        const Look = System.tick("Look", function* () {
          const pointer = yield* Input.Pointer;
          const pads = yield* Input.Gamepads;
          const pad = pads(0);
          const other = pads(1);
          seen = {
            at: [pointer.x, pointer.y],
            main: [pointer.down(), pointer.pressed(), pointer.released()],
            second: [pointer.down(2), pointer.pressed(2), pointer.released(2)],
            stick: [pad.axis(0), pad.axis(1), pad.axis(2)],
            a: [pad.down(0), pad.pressed(0), pad.released(0)],
            other: [other.axis(0), other.down(0), other.pressed(3)],
          };
        });
        const app = yield* App.make(
          App.define({ plugins: [Input.plugin], systems: [Look] })
        );
        yield* app.input();
        yield* app.tick(1);
        expect(seen).toEqual({
          at: [0, 0],
          main: [false, false, false],
          second: [false, false, false],
          stick: [0, 0, 0],
          a: [false, false, false],
          other: [0, false, false],
        });
        source.move(Input.pointerX, 120);
        source.move(Input.pointerY, 45.5);
        source.press(Input.pointerButton(2));
        source.move(Input.padAxis(0, 1), -0.75);
        source.press(Input.padButton(0, 0));
        source.move(Input.padAxis(1, 0), 0.5);
        source.press(Input.padButton(1, 3));
        yield* app.input();
        yield* app.tick(1);
        expect(seen).toEqual({
          at: [120, 45.5],
          main: [false, false, false],
          second: [true, true, false],
          stick: [0, -0.75, 0],
          a: [true, true, false],
          other: [0.5, false, true],
        });
        source.release(Input.pointerButton(2));
        source.press(Input.pointerButton());
        source.move(Input.padAxis(0, 1), 0);
        source.release(Input.padButton(0, 0));
        yield* app.input();
        yield* app.tick(1);
        expect(seen).toEqual({
          at: [120, 45.5],
          main: [true, true, false],
          second: [false, false, true],
          stick: [0, 0, 0],
          a: [false, false, true],
          other: [0.5, false, false],
        });
        // The codes are what they say.
        expect([
          Input.pointerX,
          Input.pointerY,
          Input.pointerButton(),
          Input.pointerButton(1),
          Input.padButton(2, 7),
          Input.padAxis(3, 1),
        ]).toEqual([
          "PointerX",
          "PointerY",
          "Pointer0",
          "Pointer1",
          "Pad2Button7",
          "Pad3Axis1",
        ]);
      }).pipe(withSource(source));
    })
  );

  it.effect(
    "goes through the action log, so a replay needs no devices at all",
    () =>
      Effect.gen(function* () {
        const source = Input.makeManualSource();
        const { hashes, played, text, ticks } = yield* Effect.gen(function* () {
          const app = yield* App.make(App.define({ plugins: [Flying] }), {
            hashEvery: 1,
            seed: 9,
          });
          const step = Driver.fixedStep(app, { hz: 10 });
          const tickHashes: number[] = [];
          const frame = Effect.fnUntraced(function* () {
            yield* step(0.1);
            tickHashes.push(yield* hashOf(app));
          });
          yield* frame();
          source.press("ArrowRight");
          yield* frame();
          yield* frame();
          source.press("Space");
          yield* frame();
          source.release("ArrowRight");
          source.release("Space");
          source.press("ArrowLeft");
          source.move(Input.pointerX, 33);
          yield* frame();
          source.tap("Space");
          yield* frame();
          yield* frame();
          expect(reports(app)).toEqual([
            { down: ["ArrowRight"] },
            { down: ["Space"] },
            {
              down: ["ArrowLeft"],
              up: ["ArrowRight", "Space"],
              axes: { PointerX: 33 },
            },
            { tapped: ["Space"] },
          ]);
          return {
            hashes: tickHashes,
            text: yield* Replay.encode(yield* Replay.record(app)),
            played: yield* ship(app),
            ticks: app.time.tick,
          };
        }).pipe(withSource(source));
        // Right for 3 ticks, left for 3, a tenth of a second each; two shots.
        expect(played.x).toBeCloseTo(0, 5);
        expect(played.shots).toBe(2);
        expect(ticks).toBe(7);

        // The replay is given no source, and its input stage is never run.
        const decoded = Replay.decode(text);
        assert(Exit.isSuccess(decoded));
        const recording = decoded.value;
        const entries = recording.log;
        const again = yield* Replay.verify(
          recording,
          App.define({ plugins: [Flying] }),
          { hashEvery: 1 }
        );
        expect(yield* ship(again)).toEqual(played);
        expect(yield* hashOf(again)).toBe(hashes.at(-1));
        // Checked against every tick's hash check on the way.
        expect(
          entries.filter((entry) => Action.isHashCheck(entry)).length
        ).toBe(ticks + 1);
        // A log that says another key was held is another game.
        const altered = entries.map((entry) =>
          !Action.isHashCheck(entry) &&
          JSON.stringify(entry.payload) === '{"down":["ArrowRight"]}'
            ? { ...entry, payload: { down: ["ArrowLeft"] } }
            : entry
        );
        const alteredRecording = { ...recording, log: altered };
        const diverged = yield* Effect.flip(
          Replay.verify(alteredRecording, App.define({ plugins: [Flying] }), {
            hashEvery: 1,
          })
        );
        expect(diverged).toBeInstanceOf(Replay.Diverged);
      })
  );

  it.effect(
    "is untouched while nothing changes: no action, and the hash of a game that has no input",
    () =>
      Effect.gen(function* () {
        const source = Input.makeManualSource();
        yield* Effect.gen(function* () {
          const app = yield* App.make(App.define({ plugins: [Flying] }), {
            hashEvery: 0,
          });
          const Bare = Plugin.make("Bare", {
            setup: Effect.map(Commands.spawns(Ship), (commands) => {
              commands.spawn(Ship.of({ x: 0, shots: 0 }));
            }),
          });
          const bare = yield* App.make(App.define({ plugins: [Bare] }), {
            hashEvery: 0,
          });
          for (let i = 0; i < 3; i++) {
            yield* app.input();
            yield* app.tick(1);
            yield* bare.tick(1);
          }
          expect(app.actionLog).toEqual([]);
          expect(yield* hashOf(app)).toBe(yield* hashOf(bare));
          source.press("KeyQ");
          yield* app.input();
          yield* app.tick(1);
          // Held still: one report, however long it is held.
          for (let i = 0; i < 5; i++) {
            yield* app.input();
            yield* app.tick(1);
          }
          expect(reports(app)).toEqual([{ down: ["KeyQ"] }]);
          expect(yield* hashOf(app)).not.toBe(yield* hashOf(bare));
        }).pipe(withSource(source));
      })
  );

  it.effect(
    "holds the same data for the same buttons, in whatever order they went down",
    () =>
      Effect.gen(function* () {
        const one = yield* App.make(App.define({ plugins: [Input.plugin] }));
        const two = yield* App.make(App.define({ plugins: [Input.plugin] }));
        yield* one.dispatch(Input.Report, {
          down: ["KeyB", "KeyA"],
          axes: { PointerY: 2, PointerX: 1 },
        });
        yield* two.dispatch(Input.Report, {
          down: ["KeyA", "KeyB"],
          axes: { PointerX: 1, PointerY: 2 },
        });
        expect(yield* hashOf(one)).toBe(yield* hashOf(two));
        // An axis back at 0 is one nobody moved.
        const still = yield* App.make(App.define({ plugins: [Input.plugin] }));
        yield* still.dispatch(Input.Report, { down: ["KeyA", "KeyB"] });
        yield* one.dispatch(Input.Report, {
          axes: { PointerX: 0, PointerY: 0 },
        });
        expect(yield* hashOf(one)).toBe(yield* hashOf(still));
        // What went up is applied before what went down: a key in both
        // was let go and pressed again, and is held.
        const repressed = yield* App.make(
          App.define({ plugins: [Input.plugin] })
        );
        yield* repressed.dispatch(Input.Report, { down: ["KeyA"] });
        yield* repressed.tick(1);
        yield* repressed.dispatch(Input.Report, {
          down: ["KeyA"],
          up: ["KeyA"],
        });
        const held = yield* App.make(App.define({ plugins: [Input.plugin] }));
        yield* held.dispatch(Input.Report, { down: ["KeyA"] });
        yield* held.tick(1);
        expect(yield* hashOf(repressed)).not.toBe(yield* hashOf(held));
        let seen = "";
        const Look = System.tick("Look", function* () {
          const keys = yield* Input.Keyboard;
          seen = `${keys.down("KeyA")} ${keys.pressed("KeyA")} ${keys.released("KeyA")}`;
        });
        const looking = yield* App.make(
          App.define({ plugins: [Input.plugin], systems: [Look] })
        );
        yield* looking.dispatch(Input.Report, { down: ["KeyA"] });
        yield* looking.tick(1);
        yield* looking.dispatch(Input.Report, { down: ["KeyA"], up: ["KeyA"] });
        yield* looking.tick(1);
        expect(seen).toBe("true true true");
        // A report that says what is so already is accepted, and writes
        // nothing: a key that is down did not go down again.
        yield* one.tick(1);
        const before = yield* hashOf(one);
        const again = yield* Effect.exit(
          one.dispatch(Input.Report, {
            down: ["KeyA"],
            up: ["KeyZ"],
            axes: { PointerX: 0 },
          })
        );
        expect(Exit.isSuccess(again)).toBe(true);
        expect(yield* hashOf(one)).toBe(before);
        const fresh = yield* App.make(App.define({ plugins: [Input.plugin] }));
        const empty = yield* hashOf(fresh);
        expect(
          Exit.isSuccess(
            yield* Effect.exit(
              fresh.dispatch(Input.Report, {
                up: ["KeyZ"],
                axes: { PointerX: 0 },
              })
            )
          )
        ).toBe(true);
        expect(
          Exit.isSuccess(yield* Effect.exit(fresh.dispatch(Input.Report, {})))
        ).toBe(true);
        expect(yield* hashOf(fresh)).toBe(empty);
      })
  );

  it.effect(
    "keeps the ticks a button last went down and up in, after it went up, and changes them only when it goes down again",
    () =>
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ plugins: [Input.plugin] }));
        const pressedLater = yield* App.make(
          App.define({ plugins: [Input.plugin] })
        );
        yield* app.dispatch(Input.Report, { down: ["KeyA", "KeyB"] });
        yield* pressedLater.dispatch(Input.Report, { down: ["KeyB"] });
        yield* app.tick(1);
        yield* pressedLater.tick(1);
        yield* app.dispatch(Input.Report, { up: ["KeyA"] });
        yield* pressedLater.dispatch(Input.Report, { tapped: ["KeyA"] });
        yield* app.tick(1);
        yield* pressedLater.tick(1);
        // Up in both, but it went down in another tick: kept, so a frame
        // drawn after several ticks still reads it.
        yield* app.tick(1);
        yield* pressedLater.tick(1);
        expect(yield* hashOf(app)).not.toBe(yield* hashOf(pressedLater));
        // A report of anything else, or that it went up, which it did long
        // ago, writes nothing of it.
        const before = yield* hashOf(app);
        const late = yield* Effect.exit(
          app.dispatch(Input.Report, { up: ["KeyA"] })
        );
        expect(Exit.isSuccess(late)).toBe(true);
        expect(yield* hashOf(app)).toBe(before);
        // Pressed and let go again in the same tick as the other: the same.
        yield* app.dispatch(Input.Report, { tapped: ["KeyA"] });
        yield* pressedLater.dispatch(Input.Report, { tapped: ["KeyA"] });
        expect(yield* hashOf(app)).toBe(yield* hashOf(pressedLater));
      })
  );

  it.effect(
    "is left as it is where there are no devices: reports from elsewhere drive a game through a driver",
    () =>
      Effect.gen(function* () {
        // A game played from a keyboard, through a driver, and its reports.
        const source = Input.makeManualSource();
        const { hashes, log } = yield* Effect.gen(function* () {
          const app = yield* App.make(App.define({ plugins: [Flying] }), {
            hashEvery: 0,
          });
          const step = Driver.fixedStep(app, { hz: 10 });
          const seen: number[] = [];
          const moves: (() => void)[] = [
            () => source.press("ArrowRight"),
            () => {},
            () => source.tap("Space"),
            () => source.release("ArrowRight"),
            () => {},
          ];
          for (const move of moves) {
            move();
            yield* step(0.1);
            seen.push(yield* hashOf(app));
          }
          return { hashes: seen, log: app.actionLog as Action.Logged[] };
        }).pipe(withSource(source));
        // The same game with no devices, given those reports as they came,
        // and run by the same driver, which runs its input stage too: as a
        // peer on another machine is, or a recording played back at speed.
        {
          const app = yield* App.make(App.define({ plugins: [Flying] }), {
            hashEvery: 0,
          });
          const step = Driver.fixedStep(app, { hz: 10 });
          for (let tick = 0; tick < hashes.length; tick++) {
            for (const entry of log.filter((one) => one.tick === tick)) {
              yield* app.enqueueByName(entry.name, entry.payload);
            }
            yield* step(0.1);
            expect(yield* hashOf(app), `tick ${tick + 1}`).toBe(hashes[tick]);
          }
          // Nothing was reported of devices that are not there.
          expect(reports(app)).toEqual(log.map((entry) => entry.payload));
          // And a key said to be held stays held, however often it is read.
          yield* app.dispatch(Input.Report, { down: ["ArrowLeft"] });
          const before = (yield* ship(app)).x;
          yield* step(0.1);
          yield* app.input();
          yield* app.input();
          yield* step(0.1);
          expect((yield* ship(app)).x).toBeCloseTo(before - 2, 5);
          expect(reports(app).length).toBe(log.length + 1);
        }
      })
  );

  it.effect(
    "is what the devices say: a report made by hand lasts until they are next read",
    () =>
      Effect.gen(function* () {
        const source = Input.makeManualSource();
        yield* Effect.gen(function* () {
          const app = yield* App.make(App.define({ plugins: [Flying] }), {
            hashEvery: 0,
          });
          const step = Effect.fnUntraced(function* () {
            yield* app.input();
            yield* app.tick(1);
          });
          // The key has a history: down, and up again.
          source.press("ArrowRight");
          yield* step();
          source.release("ArrowRight");
          yield* step();
          expect((yield* ship(app)).x).toBe(10);
          // A tool says it is down. No device does. A tick with no input
          // stage before it takes the tool's word.
          yield* app.dispatch(Input.Report, { down: ["ArrowRight"] });
          yield* app.tick(1);
          expect((yield* ship(app)).x).toBe(20);
          // One with the stage before it is told the key is up before it
          // runs.
          yield* app.dispatch(Input.Report, { down: ["ArrowRight"] });
          yield* step();
          expect((yield* ship(app)).x).toBe(20);
          expect(reports(app).at(-1)).toEqual({ up: ["ArrowRight"] });
          yield* app.dispatch(Input.Report, { down: ["ArrowRight"] });
          yield* app.tick(1);
          expect((yield* ship(app)).x).toBe(30);
          yield* step();
          expect(reports(app).at(-1)).toEqual({ up: ["ArrowRight"] });
          expect((yield* ship(app)).x).toBe(30);
        }).pipe(withSource(source));
      })
  );

  it.effect(
    "refuses a report that is not one, as any action's payload is checked",
    () =>
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ plugins: [Input.plugin] }));
        const before = yield* hashOf(app);
        for (const payload of [
          { down: "KeyA" },
          { axes: { PointerX: "left" } },
          { axes: { PointerX: null } },
          { up: [1] },
        ]) {
          const exit = yield* Effect.exit(
            app.dispatchByName("arcadekit/Input.Report", payload)
          );
          expect(Exit.isFailure(exit), JSON.stringify(payload)).toBe(true);
          expect(
            Cause.squash((exit as Exit.Failure<unknown, unknown>).cause)
          ).toBeInstanceOf(Action.InvalidPayload);
        }
        const exit = yield* Effect.exit(
          app.dispatch(Input.Report, {
            axes: { PointerX: Number.POSITIVE_INFINITY },
          })
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* hashOf(app)).toBe(before);
      })
  );

  it.effect(
    "is saved with a game, and brought up to date by the devices when it is loaded",
    () =>
      Effect.gen(function* () {
        const source = Input.makeManualSource();
        const save = yield* Effect.gen(function* () {
          const app = yield* App.make(App.define({ plugins: [Flying] }));
          source.press("ArrowRight");
          source.move(Input.pointerX, 50);
          yield* app.input();
          yield* app.tick(1);
          expect((yield* ship(app)).x).toBe(10);
          const taken = yield* Effect.exit(Save.make(app));
          assert(Exit.isSuccess(taken));
          return taken.value;
        }).pipe(withSource(source));
        // Loaded with no devices and never asked to read any: the key is held.
        {
          const app = yield* App.make(App.define({ plugins: [Flying] }), {
            save,
          });
          yield* app.tick(1);
          yield* app.tick(1);
          expect((yield* ship(app)).x).toBe(30);
        }
        // Loaded where the key is no longer down: the first read lets it go.
        const later = Input.makeManualSource();
        later.move(Input.pointerX, 50);
        yield* Effect.gen(function* () {
          const app = yield* App.make(App.define({ plugins: [Flying] }), {
            save,
          });
          yield* app.input();
          yield* app.tick(1);
          expect((yield* ship(app)).x).toBe(10);
          expect(reports(app)).toEqual([{ up: ["ArrowRight"] }]);
          yield* app.input();
          yield* app.tick(1);
          expect(reports(app).length).toBe(1);
        }).pipe(withSource(later));
        // Loaded where there is no pointer either: its place goes back to 0.
        yield* Effect.gen(function* () {
          const app = yield* App.make(App.define({ plugins: [Flying] }), {
            save,
          });
          yield* app.input();
          expect(reports(app)).toEqual([
            { up: ["ArrowRight"], axes: { PointerX: 0 } },
          ]);
        }).pipe(withSource(Input.makeManualSource()));
      })
  );

  it.effect(
    "says in a handler what its tick's systems will be told: the tick an action is applied in is the one to come",
    () =>
      Effect.gen(function* () {
        const seen: string[] = [];
        const Probe = Action.define("in/Probe", Schema.Struct({}));
        const probe = Action.handler(Probe, function* () {
          const keys = yield* Input.Keyboard;
          seen.push(
            `handler ${(yield* Time).tick + 1}:${keys.down("Space") ? " down" : ""}${keys.pressed("Space") ? " pressed" : ""}${keys.released("Space") ? " released" : ""}`
          );
        });
        const Look = System.tick("Look", function* () {
          const keys = yield* Input.Keyboard;
          seen.push(
            `system ${(yield* Time).tick}:${keys.down("Space") ? " down" : ""}${keys.pressed("Space") ? " pressed" : ""}${keys.released("Space") ? " released" : ""}`
          );
        });
        // An input system issues the action when the key goes down or up, so
        // both arrive in the same tick: the report first, since the plugin's
        // system runs before the game's.
        const Key = Input.button("in/ProbeKey", ["Space"]);
        const Probing = System.input("in/Probing", function* () {
          const key = yield* Key;
          if (key.pressed || key.released) {
            (yield* Action.Actions).enqueue(Probe, {});
          }
        });
        const source = Input.makeManualSource();
        yield* Effect.gen(function* () {
          const app = yield* App.make(
            App.define({
              plugins: [Input.controls("in/ProbeKeys", [Key])],
              handlers: [probe],
              systems: [Probing, Look],
            })
          );
          const step = Effect.fnUntraced(function* () {
            yield* app.input();
            yield* app.tick(1);
          });
          source.press("Space");
          yield* step();
          // Held, and an action that comes a tick later: the press is past.
          yield* app.enqueue(Probe, {});
          yield* step();
          source.release("Space");
          yield* step();
          expect(seen).toEqual([
            "handler 1: down pressed",
            "system 1: down pressed",
            "handler 2: down",
            "system 2: down",
            "handler 3: released",
            "system 3: released",
          ]);
          // Dispatched between two ticks, an action belongs to the one to
          // come as well.
          seen.length = 0;
          yield* app.dispatch(Input.Report, { down: ["Space"] });
          yield* app.dispatch(Probe, {});
          yield* app.tick(1);
          yield* app.dispatch(Probe, {});
          expect(seen).toEqual([
            "handler 4: down pressed",
            "system 4: down pressed",
            "handler 5: down",
          ]);
        }).pipe(withSource(source));
      })
  );

  it.effect("is each world's own", () =>
    Effect.gen(function* () {
      const left = Input.makeManualSource();
      const right = Input.makeManualSource();
      const one = yield* App.make(App.define({ plugins: [Flying] })).pipe(
        withSource(left)
      );
      const two = yield* App.make(App.define({ plugins: [Flying] })).pipe(
        withSource(right)
      );
      left.press("ArrowLeft");
      right.press("ArrowRight");
      for (const app of [one, two]) {
        yield* app.input();
        yield* app.tick(1);
        yield* app.tick(1);
      }
      expect((yield* ship(one)).x).toBe(-20);
      expect((yield* ship(two)).x).toBe(20);
    })
  );

  it.effect(
    "is read by a handler and by what draws the game, as by a system",
    () =>
      Effect.gen(function* () {
        class NotHeld extends Schema.TaggedError<NotHeld>()("NotHeld", {}) {}
        const Shoot = Action.define("in/Shoot", Schema.Struct({}), {
          error: NotHeld,
        });
        const shoot = Action.handler(Shoot, function* () {
          if (!(yield* Input.Keyboard).down("Space")) {
            return yield* NotHeld.make({});
          }
          (yield* Score.writes).points += 1;
        });
        const source = Input.makeManualSource();
        yield* Effect.gen(function* () {
          const drawn: string[] = [];
          const Draw = System.frame("Draw", function* () {
            const pointer = yield* Input.Pointer;
            drawn.push(`${pointer.x},${pointer.y} ${pointer.down()}`);
          });
          const app = yield* App.make(
            App.define({
              plugins: [Input.plugin],
              handlers: [shoot],
              systems: [Draw],
            })
          );
          expect(
            Exit.isFailure(yield* Effect.exit(app.dispatch(Shoot, {})))
          ).toBe(true);
          source.press("Space");
          source.move(Input.pointerX, 3);
          source.press(Input.pointerButton());
          yield* app.input();
          yield* app.tick(1);
          const before = yield* hashOf(app);
          yield* app.frame();
          expect(drawn).toEqual(["3,0 true"]);
          expect(yield* hashOf(app)).toBe(before);
          expect(
            Exit.isSuccess(yield* Effect.exit(app.dispatch(Shoot, {})))
          ).toBe(true);
          expect(yield* pointsOf(app)).toBe(1);
          // A refused action leaves the picture as it was.
          source.release("Space");
          yield* app.input();
          yield* app.tick(1);
          const held = yield* hashOf(app);
          expect(
            Exit.isFailure(yield* Effect.exit(app.dispatch(Shoot, {})))
          ).toBe(true);
          expect(yield* hashOf(app)).toBe(held);
        }).pipe(withSource(source));
      })
  );

  it.effect(
    "is seen by what draws the game once for each change, however many frames a tick has or ticks a frame has",
    () =>
      Effect.gen(function* () {
        const source = Input.makeManualSource();
        yield* Effect.gen(function* () {
          const seen: string[] = [];
          const Flash = System.frame("Flash", function* () {
            const keys = yield* Input.Keyboard;
            const pointer = yield* Input.Pointer;
            const pad = (yield* Input.Gamepads)(0);
            const { count } = yield* Frame;
            const changes: readonly (readonly [string, boolean, boolean])[] = [
              ["Space", keys.pressed("Space"), keys.released("Space")],
              ["KeyA", keys.pressed("KeyA"), keys.released("KeyA")],
              ["pointer", pointer.pressed(), pointer.released()],
              ["pad", pad.pressed(0), pad.released(0)],
            ];
            for (const [name, pressed, released] of changes) {
              if (pressed) {
                seen.push(`${count} ${name} pressed`);
              }
              if (released) {
                seen.push(`${count} ${name} released`);
              }
            }
          });
          const app = yield* App.make(
            App.define({ plugins: [Input.plugin], systems: [Flash] })
          );
          const step = Effect.fnUntraced(function* () {
            yield* app.input();
            yield* app.tick(1);
          });
          // Three frames of one tick: the first sees the press, and no other.
          source.press("Space");
          yield* step();
          yield* app.frame(0.2);
          yield* app.frame(0.6);
          yield* app.frame(0.9);
          expect(seen).toEqual(["1 Space pressed"]);
          // One frame of two ticks: a press in the first is seen after the
          // second.
          seen.length = 0;
          source.press(Input.pointerButton());
          yield* step();
          yield* step();
          yield* app.frame();
          expect(seen).toEqual(["4 pointer pressed"]);
          // Down in one tick, up in the next, and something else in a third:
          // the one frame after them sees each change.
          seen.length = 0;
          source.press("KeyA");
          yield* step();
          source.release("KeyA");
          yield* step();
          source.press(Input.padButton(0, 0));
          yield* step();
          yield* app.frame();
          yield* app.frame();
          expect(seen).toEqual([
            "5 KeyA pressed",
            "5 KeyA released",
            "5 pad pressed",
          ]);
          seen.length = 0;
          source.release("Space");
          yield* step();
          yield* app.frame();
          yield* app.frame();
          expect(seen).toEqual(["7 Space released"]);
          // Through a driver, with frames shorter than a tick, then longer.
          const driven = Driver.fixedStep(app, { hz: 10 });
          for (const frame of [0.04, 0.25]) {
            seen.length = 0;
            source.tap("KeyA");
            for (let i = 0; i < 5; i++) {
              yield* driven(frame);
            }
            expect(
              seen.map((line) => line.replace(/^\d+ /u, "")),
              `frames of ${frame} s`
            ).toEqual(["KeyA pressed", "KeyA released"]);
          }
        }).pipe(withSource(source));
      })
  );

  it.effect(
    "is new to what draws the game after a rewind, as the events of the ticks run again are",
    () =>
      Effect.gen(function* () {
        const seen: number[] = [];
        const Flash = System.frame("Flash", function* () {
          if ((yield* Input.Keyboard).pressed("KeyA")) {
            seen.push((yield* Frame).count);
          }
        });
        const app = yield* App.make(
          App.define({ plugins: [Input.plugin], systems: [Flash] })
        );
        const moment = yield* Timeline.capture(app);
        yield* app.dispatch(Input.Report, { down: ["KeyA"] });
        yield* app.tick(1);
        yield* app.frame();
        yield* app.tick(1);
        yield* app.tick(1);
        yield* app.frame();
        expect(seen).toEqual([1]);
        yield* Timeline.rewind(app, moment);
        yield* app.dispatch(Input.Report, { down: ["KeyA"] });
        yield* app.tick(1);
        yield* app.frame();
        expect(seen).toEqual([1, 3]);
      })
  );

  it.effect(
    "is shown once by what draws the game when a rollback runs again the ticks it drew, and a press only the ticks run again have is shown once too",
    () =>
      Effect.gen(function* () {
        const seen: string[] = [];
        const Flash = System.frame("Flash", function* () {
          const keys = yield* Input.Keyboard;
          const { count } = yield* Frame;
          for (const code of ["KeyA", "KeyB"] as const) {
            if (keys.pressed(code)) {
              seen.push(`${count} ${code}`);
            }
          }
        });
        const app = yield* App.make(
          App.define({ plugins: [Input.plugin], systems: [Flash] })
        );
        // A game that runs ahead, as a rollback session does: it draws what
        // it predicted, goes back past what it drew, and runs those ticks
        // again with what it now knows.
        const first = yield* Timeline.capture(app);
        yield* app.dispatch(Input.Report, { down: ["KeyA"] });
        yield* app.tick(1);
        yield* app.frame();
        yield* app.tick(1);
        yield* app.frame();
        expect(seen).toEqual(["1 KeyA"]);
        // The prediction was right: the press it drew is run again.
        yield* Timeline.rewind(app, first, { again: true });
        yield* app.dispatch(Input.Report, { down: ["KeyA"] });
        yield* app.tick(1);
        yield* app.tick(1);
        yield* app.tick(1);
        yield* app.frame();
        expect(seen).toEqual(["1 KeyA"]);
        // It was wrong: a press it missed comes in a tick it drew.
        const second = yield* Timeline.capture(app);
        yield* app.tick(1);
        yield* app.frame();
        yield* Timeline.rewind(app, second, { again: true });
        yield* app.dispatch(Input.Report, { down: ["KeyB"] });
        yield* app.tick(1);
        yield* app.tick(1);
        yield* app.frame();
        yield* app.frame();
        expect(seen).toEqual(["1 KeyA", "5 KeyB"]);
      })
  );

  it.effect(
    "is not shown by what draws the game for a press of a save loaded in place: that game's past is no frame's",
    () =>
      Effect.gen(function* () {
        const seen: number[] = [];
        const Flash = System.frame("Flash", function* () {
          if ((yield* Input.Keyboard).pressed("KeyA")) {
            seen.push((yield* Frame).count);
          }
        });
        const Game = App.define({ plugins: [Input.plugin], systems: [Flash] });
        const played = yield* App.make(Game);
        yield* played.tick(1);
        yield* played.dispatch(Input.Report, { down: ["KeyA"] });
        yield* played.tick(1);
        const save = yield* Save.make(played);
        // Another app, which has drawn nothing past its first tick, loads it.
        const app = yield* App.make(Game);
        yield* app.frame();
        yield* Save.load(app, save);
        yield* app.frame();
        yield* app.tick(1);
        yield* app.frame();
        expect(seen).toEqual([]);
        // What it does from there is shown as ever.
        yield* app.dispatch(Input.Report, { up: ["KeyA"] });
        yield* app.dispatch(Input.Report, { down: ["KeyA"] });
        yield* app.tick(1);
        yield* app.frame();
        expect(seen).toEqual([4]);
      })
  );

  it.effect(
    "is shown once by what draws the game in a session that rolls back past what it drew",
    () =>
      Effect.gen(function* () {
        const seen: string[] = [];
        const Flash = System.frame("Flash", function* () {
          const keys = yield* Input.Keyboard;
          for (const code of ["Space", "KeyB"] as const) {
            if (keys.pressed(code)) {
              seen.push(code);
            }
          }
        });
        const source = Input.makeManualSource();
        const ada = yield* Session.make(
          App.define({ plugins: [Input.plugin], systems: [Flash] }),
          { me: "ada", others: ["grace"], hz: 60, ahead: 8 }
        ).pipe(withSource(source));
        const step = Effect.fnUntraced(function* () {
          expect(yield* ada.tick()).toBe(true);
          yield* ada.frame(0);
        });
        yield* step();
        source.press("Space");
        yield* step();
        yield* step();
        expect(seen).toEqual(["Space"]);
        // Grace moved the pointer on the first tick: ada goes back past the
        // frames that showed the space bar, and runs its press again.
        ada.receive({
          from: "grace",
          tick: 0,
          actions: [
            { name: Input.Report.name, payload: { axes: { PointerX: 5 } } },
          ],
        });
        yield* step();
        expect(ada.stats.rewinds).toBe(1);
        expect(seen).toEqual(["Space"]);
        // And she pressed B on the second, which ada had drawn without it.
        ada.receive({
          from: "grace",
          tick: 1,
          actions: [{ name: Input.Report.name, payload: { down: ["KeyB"] } }],
        });
        yield* step();
        yield* step();
        expect(ada.stats.rewinds).toBe(2);
        expect(seen).toEqual(["Space", "KeyB"]);
      })
  );
});

describe("controls", () => {
  const Jump = Input.button("in/Jump", [
    "Space",
    "KeyW",
    Input.padButton(0, 0),
  ]);
  const Steer = Input.axis("in/Steer", {
    negative: ["ArrowLeft"],
    positive: ["ArrowRight"],
    pad: Input.padAxis(0, 0),
  });
  const Move = Input.stick("in/Move", {
    left: ["KeyA"],
    right: ["KeyD"],
    up: ["KeyW"],
    down: ["KeyS"],
    pad: Input.padStick(0, "left"),
  });
  const Controls = Input.controls("in/Controls", [Jump, Steer, Move]);
  /** A button's state in a tick, in a form that compares. */
  const said = (tick: number, state: Input.ButtonState): string =>
    `${tick}:${state.held ? " held" : ""}${state.pressed ? " pressed" : ""}${state.released ? " released" : ""}`;
  const rounded = (values: readonly number[]): number[] =>
    values.map((value) => Math.round(value * 1000) / 1000);

  it("are read where an Input.controls declares them, are named with a slash, and are bound to codes that are codes", () => {
    const reads = [
      System.tick("in/Tick", function* () {
        void (yield* Jump).held;
      }),
      System.frame("in/Frame", function* () {
        void (yield* Steer);
      }),
      System.input("in/Input", function* () {
        void (yield* Move).x;
      }),
    ] as const;
    for (const system of reads) {
      // Input.plugin keeps the devices, and declares no control.
      expectTypeOf(
        App.make(App.define({ plugins: [Input.plugin], systems: [system] }))
      ).not.toExtend<Effect.Effect<unknown, never>>();
      expectTypeOf(
        App.make(App.define({ plugins: [Controls], systems: [system] }))
      ).toExtend<Effect.Effect<unknown, never>>();
    }
    const Probe = Action.define("in/ProbeJump", Schema.Struct({}));
    const probe = Action.handler(Probe, function* () {
      void (yield* Jump).pressed;
    });
    expectTypeOf(
      App.make(App.define({ plugins: [Input.plugin], handlers: [probe] }))
    ).not.toExtend<Effect.Effect<unknown, never>>();
    expectTypeOf(
      App.make(App.define({ plugins: [Controls], handlers: [probe] }))
    ).toExtend<Effect.Effect<unknown, never>>();
    expectTypeOf(Jump).toExtend<
      Effect.Effect<Input.ButtonState, never, Input.Declared<"in/Jump">>
    >();
    expectTypeOf(Move).toExtend<
      Effect.Effect<Input.StickState, never, Input.Declared<"in/Move">>
    >();
    // A name is its feature and what it is, and a code is one a device has.
    const refused = [
      // @ts-expect-error a name with no slash
      Input.button("Jump", ["Space"]),
      Input.button("in/Typo", [
        // @ts-expect-error a key's code spelt wrong
        "Spce",
      ]),
      Input.axis("in/Typo", {
        // @ts-expect-error the pointer's place is no gamepad's axis
        pad: Input.pointerX,
      }),
      Input.rebind(
        Steer,
        // @ts-expect-error an axis is not bound to a list of codes
        ["KeyK"]
      ),
    ];
    expect(refused.length).toBe(4);
    const source = Input.makeManualSource();
    // @ts-expect-error a key's code spelt wrong
    source.press("Arrowleft");
    System.tick("in/Keys", function* () {
      const keys = yield* Input.Keyboard;
      // @ts-expect-error a pointer's button is no key
      return keys.down(Input.pointerButton()) ? undefined : undefined;
    });
    expect([
      Input.isKeyCode("Space"),
      Input.isKeyCode("Spce"),
      Input.isKeyCode("Pointer0"),
      Input.isKeyCode(""),
    ]).toEqual([true, false, false, false]);
    expect(Input.padStick(1, "right")).toEqual({
      x: "Pad1Axis2",
      y: "Pad1Axis3",
    });
    // Rebinding is a setting, which the tick doesn't touch, and takes the
    // control's own bindings.
    System.tick(
      "in/Rebind",
      // @ts-expect-error the tick does not rebind
      function* () {
        yield* Input.rebind(Jump, ["KeyK"]);
      }
    );
  });

  it.effect(
    "hold a button while any of its codes is down, and press and release it once, as the tick sees it",
    () =>
      Effect.gen(function* () {
        const source = Input.makeManualSource();
        yield* Effect.gen(function* () {
          const seen: string[] = [];
          const Look = System.tick("in/Look", function* () {
            seen.push(said((yield* Time).tick, yield* Jump));
          });
          const app = yield* App.make(
            App.define({ plugins: [Controls], systems: [Look] }),
            { hashEvery: 0 }
          );
          const step = Effect.fnUntraced(function* () {
            yield* app.input();
            yield* app.tick(1);
          });
          yield* step();
          source.press("Space");
          yield* step();
          // A second of its codes, while the first is held, is no new press.
          source.press("KeyW");
          yield* step();
          // Nor is letting go of one while the other is held a release.
          source.release("Space");
          yield* step();
          source.release("KeyW");
          yield* step();
          source.tap(Input.padButton(0, 0));
          yield* step();
          yield* step();
          // Let go and pressed again between two samples: it went up, it went
          // down, and it is held.
          source.press("Space");
          yield* step();
          source.release("Space");
          source.press("Space");
          yield* step();
          expect(seen).toEqual([
            "1:",
            "2: held pressed",
            "3: held",
            "4: held",
            "5: released",
            "6: pressed released",
            "7:",
            "8: held pressed",
            "9: held pressed released",
          ]);
          // In the log by its name, beside the device's own code.
          expect(reports(app).slice(0, 2)).toEqual([
            { down: ["Space", "in/Jump"] },
            { down: ["KeyW"], axes: { "in/Move.y": 1 } },
          ]);
          // A report from elsewhere drives it, with no input stage run.
          const bare = yield* App.make(
            App.define({ plugins: [Controls], systems: [Look] })
          );
          seen.length = 0;
          yield* bare.dispatch(Input.Report, { down: ["in/Jump"] });
          yield* bare.tick(1);
          expect(seen).toEqual(["1: held pressed"]);
        }).pipe(withSource(source));
      })
  );

  it.effect(
    "give an axis from -1 to 1, and a stick of length 1 at most with y up, from keys and a gamepad",
    () =>
      Effect.gen(function* () {
        const source = Input.makeManualSource();
        yield* Effect.gen(function* () {
          const seen: number[][] = [];
          const Look = System.tick("in/Look", function* () {
            const move = yield* Move;
            seen.push(rounded([yield* Steer, move.x, move.y]));
          });
          const app = yield* App.make(
            App.define({ plugins: [Controls], systems: [Look] })
          );
          const step = Effect.fnUntraced(function* () {
            yield* app.input();
            yield* app.tick(1);
          });
          const pad = Input.padStick(0, "left");
          const moves: (() => void)[] = [
            () => {},
            () => source.press("ArrowRight"),
            // Both ways at once is neither.
            () => source.press("ArrowLeft"),
            () => {
              source.releaseAll();
              source.move(pad.x, 0.5);
            },
            // Inside the stick's dead zone, which the axis has not.
            () => source.move(pad.x, 0.1),
            // A gamepad's up is -1, and a stick's is 1.
            () => {
              source.move(pad.x, 0);
              source.move(pad.y, -1);
            },
            // Two keys at once are a diagonal of length 1.
            () => {
              source.move(pad.y, 0);
              source.press("KeyD");
              source.press("KeyW");
            },
            // The keys and the gamepad together go no further than 1.
            () => {
              source.release("KeyW");
              source.move(pad.x, 1);
            },
          ];
          for (const move of moves) {
            move();
            yield* step();
          }
          expect(seen).toEqual([
            [0, 0, 0],
            [1, 0, 0],
            [0, 0, 0],
            [0.5, 0.375, 0],
            [0.1, 0, 0],
            [0, 0, 1],
            [0, 0.707, 0.707],
            [1, 1, 0],
          ]);
        }).pipe(withSource(source));
      })
  );

  it.effect(
    "are read by every stage: the tick in its tick, a frame since the last frame, and the input stage from its sample",
    () =>
      Effect.gen(function* () {
        const source = Input.makeManualSource();
        yield* Effect.gen(function* () {
          const seen: string[] = [];
          const Flash = System.frame("in/Flash", function* () {
            const jump = yield* Jump;
            const { count } = yield* Frame;
            seen.push(`frame ${count}${jump.pressed ? " pressed" : ""}`);
          });
          const Hear = System.input("in/Hear", function* () {
            const jump = yield* Jump;
            const pointer = yield* Input.Pointer;
            seen.push(
              `input${jump.held ? " held" : ""}${jump.pressed ? " pressed" : ""} ${pointer.x},${pointer.y}`
            );
          });
          const Look = System.tick("in/Look", function* () {
            seen.push(said((yield* Time).tick, yield* Jump));
          });
          const app = yield* App.make(
            App.define({ plugins: [Controls], systems: [Look, Hear, Flash] })
          );
          source.press("KeyW");
          source.move(Input.pointerX, 12);
          source.move(Input.pointerY, 34);
          yield* app.input();
          yield* app.tick(1);
          yield* app.frame(0.3);
          yield* app.frame(0.6);
          yield* app.input();
          yield* app.tick(1);
          yield* app.frame();
          expect(seen).toEqual([
            // The input stage reads the sample it was given, ahead of the
            // world, which hears of it at the next tick.
            "input held pressed 12,34",
            "1: held pressed",
            "frame 1 pressed",
            "frame 2",
            "input held 12,34",
            "2: held",
            "frame 3",
          ]);
        }).pipe(withSource(source));
      })
  );

  it.effect(
    "are rebound by a frame or an input system from the next sample on, for one app, outside the world",
    () =>
      Effect.gen(function* () {
        const shown: string[] = [];
        const Settings = System.input("in/Settings", function* () {
          const { pressed } = yield* Input.Devices;
          if (pressed.includes("Enter")) {
            yield* Input.rebind(Jump, ["KeyK"]);
          }
          if (pressed.includes("Escape")) {
            yield* Input.rebind(Jump, Jump.bindings);
          }
          shown.push((yield* Input.bindingsOf(Jump)).join(" "));
        });
        const seen: string[] = [];
        const Look = System.tick("in/Look", function* () {
          seen.push(said((yield* Time).tick, yield* Jump));
        });
        const Game = App.define({
          plugins: [Controls],
          systems: [Settings, Look],
        });
        // The same game with no menu to rebind it.
        const Plain = App.define({ plugins: [Controls], systems: [Look] });
        const source = Input.makeManualSource();
        const other = Input.makeManualSource();
        const app = yield* App.make(Game, { hashEvery: 0 }).pipe(
          withSource(source)
        );
        const plain = yield* App.make(Plain, { hashEvery: 0 }).pipe(
          withSource(other)
        );
        const step = Effect.fnUntraced(function* () {
          for (const each of [app, plain]) {
            yield* each.input();
            yield* each.tick(1);
          }
        });
        source.tap("Enter");
        other.tap("Enter");
        yield* step();
        // The world, the log and a save know nothing of it.
        expect(shown).toEqual(["KeyK"]);
        expect(yield* hashOf(app)).toBe(yield* hashOf(plain));
        expect(reports(app)).toEqual(reports(plain));
        // The key it is bound to now holds it, in this app alone.
        seen.length = 0;
        source.tap("KeyK");
        other.tap("KeyK");
        yield* step();
        source.tap("Space");
        other.tap("Space");
        yield* step();
        expect(seen).toEqual([
          "2: pressed released",
          "2:",
          "3:",
          "3: pressed released",
        ]);
        // A save holds none of it: another app of the game, loaded from it,
        // is bound as declared.
        const taken = yield* Effect.exit(Save.make(app));
        assert(Exit.isSuccess(taken));
        const loaded = yield* App.make(Game, { save: taken.value }).pipe(
          withSource(other)
        );
        shown.length = 0;
        yield* loaded.input();
        expect(shown).toEqual(["Space KeyW Pad0Button0"]);
        // And the bindings it was declared with are put back.
        seen.length = 0;
        source.tap("Escape");
        yield* app.input();
        yield* app.tick(1);
        source.tap("Space");
        yield* app.input();
        yield* app.tick(1);
        expect(seen).toEqual(["4:", "5: pressed released"]);
      })
  );

  it.effect(
    "refuse two controls of one name, or a stick and an axis that keep the same state",
    () =>
      Effect.gen(function* () {
        const Again = Input.button("in/Jump", ["KeyZ"]);
        expect(
          yield* thrown(
            App.make(
              App.define({
                plugins: [Controls, Input.controls("in/More", [Again])],
              })
            )
          )
        ).toThrow(
          'The control "in/Jump" was declared where "in/Jump" already was'
        );
        const Half = Input.axis("in/Move.x", { positive: ["KeyZ"] });
        expect(
          yield* thrown(
            App.make(
              App.define({
                plugins: [Controls, Input.controls("in/Half", [Half])],
              })
            )
          )
        ).toThrow(
          'The control "in/Move.x" was declared where "in/Move" already was'
        );
      })
  );
});

describe("an input system", () => {
  const Leap = Action.define("in/Leap");
  const Fire = Action.define(
    "in/Fire",
    Schema.Struct({ x: Schema.Finite, y: Schema.Finite })
  );
  const done: string[] = [];
  const handlers = [
    Action.handler(Leap, function* () {
      done.push(`leap at ${(yield* Time).tick}`);
    }),
    Action.handler(Fire, function* ({ x, y }) {
      done.push(`fire ${x},${y}`);
    }),
  ] as const;
  const Jump = Input.button("in/Jump", ["Space", Input.padButton(0, 0)]);
  const Shoot = Input.button("in/Shoot", [Input.pointerButton()]);
  // What a game of several players does with its controls: issues actions of
  // its own, which can carry the player.
  const Issue = System.input("in/Issue", function* () {
    const actions = yield* Action.Actions;
    if ((yield* Jump).pressed) {
      actions.enqueue(Leap, undefined);
    }
    if ((yield* Shoot).pressed) {
      const pointer = yield* Input.Pointer;
      actions.enqueue(Fire, { x: pointer.x, y: pointer.y });
    }
  });
  const Keys = Input.controls("in/Keys", [Jump, Shoot]);
  const Game = Plugin.make("Game", {
    plugins: [Keys],
    handlers,
    systems: [Issue],
  });
  const issued = (app: App.Any): string[] =>
    app.actionLog.flatMap((entry) =>
      Action.isHashCheck(entry) || entry.name === Input.Report.name
        ? []
        : [entry.name]
    );

  it.effect(
    "issues the game's own actions from its controls, once for each press",
    () =>
      Effect.gen(function* () {
        const source = Input.makeManualSource();
        yield* Effect.gen(function* () {
          done.length = 0;
          const app = yield* App.make(App.define({ plugins: [Game] }), {
            hashEvery: 0,
          });
          expect(app.inputOrder).toEqual(["arcadekit/Input.Read", "in/Issue"]);
          const step = Effect.fnUntraced(function* () {
            yield* app.input();
            yield* app.tick(1);
          });
          yield* step();
          expect(done).toEqual([]);
          // Two of its codes at once is one press.
          source.press("Space");
          source.press(Input.padButton(0, 0));
          yield* step();
          expect(done).toEqual(["leap at 1"]);
          // One let go while the other is held, then tapped again: nothing
          // more.
          source.release("Space");
          yield* step();
          source.tap("Space");
          yield* step();
          expect(done.length).toBe(1);
          source.release(Input.padButton(0, 0));
          source.move(Input.pointerX, 40);
          source.move(Input.pointerY, 30);
          source.press(Input.pointerButton());
          yield* step();
          expect(done.slice(1)).toEqual(["fire 40,30"]);
          // A button of the pointer that is not the main one fires nothing.
          source.press(Input.pointerButton(1));
          yield* step();
          expect(done.length).toBe(2);
          source.tap("Space");
          yield* step();
          expect(done.slice(2)).toEqual(["leap at 6"]);
          expect(issued(app)).toEqual(["in/Leap", "in/Fire", "in/Leap"]);
        }).pipe(withSource(source));
      })
  );

  it.effect(
    "is in the log as the actions it issued, so a replay has them and reads no device",
    () =>
      Effect.gen(function* () {
        const source = Input.makeManualSource();
        const recording = yield* Effect.gen(function* () {
          done.length = 0;
          const app = yield* App.make(App.define({ plugins: [Game] }), {
            hashEvery: 1,
          });
          source.press("Space");
          source.move(Input.pointerX, 7);
          yield* app.input();
          yield* app.tick(1);
          source.tap(Input.pointerButton());
          yield* app.input();
          yield* app.tick(1);
          return yield* Replay.record(app);
        }).pipe(withSource(source));
        const played = [...done];
        expect(played).toEqual(["leap at 0", "fire 7,0"]);
        done.length = 0;
        // The replay runs no input stage: what the controls said, and the
        // actions issued from them, are in the log.
        yield* Replay.verify(recording, App.define({ plugins: [Game] }), {
          hashEvery: 1,
        });
        expect(done).toEqual(played);
      })
  );

  it.effect(
    "throws for a payload the action's schema refuses, which no other peer could hear of",
    () =>
      Effect.gen(function* () {
        const Step = Action.define(
          "in/Step",
          Schema.Struct({ by: Schema.Int })
        );
        const Walk = System.input("in/Walk", function* () {
          const devices = yield* Input.Devices;
          if (devices.moved.includes(Input.pointerX)) {
            (yield* Action.Actions).enqueue(Step, {
              by: devices.axes.get(Input.pointerX) ?? 0,
            });
          }
        });
        const source = Input.makeManualSource();
        yield* Effect.gen(function* () {
          const app = yield* App.make(
            App.define({
              handlers: [Action.handler(Step, function* () {})],
              systems: [Walk],
            })
          );
          source.move(Input.pointerX, 2);
          yield* app.input();
          source.move(Input.pointerX, 2.5);
          expect(yield* thrown(app.input())).toThrow(
            'A system of the frame or input stage issued the action "in/Step" with a payload its schema does not take: Expected an integer'
          );
        }).pipe(withSource(source));
      })
  );

  it.effect("says so when the action it issues has no handler", () =>
    Effect.gen(function* () {
      const source = Input.makeManualSource();
      yield* Effect.gen(function* () {
        const app = yield* App.make(
          App.define({ plugins: [Keys], systems: [Issue] })
        );
        yield* app.input();
        source.press("Space");
        expect(yield* thrown(app.input())).toThrow(
          /No handler for action "in\/Leap"/
        );
      }).pipe(withSource(source));
    })
  );
});

describe("a platformer", () => {
  const Jump = Input.button("pf/Jump", ["Space", Input.padButton(0, 0)]);
  const Move = Input.axis("pf/Move", {
    negative: ["ArrowLeft", "KeyA"],
    positive: ["ArrowRight", "KeyD"],
    pad: Input.padAxis(0, 0),
  });
  const Hero = Singleton.define(
    "pf/Hero",
    { x: Field.f64, y: Field.f64, rise: Field.f64, jumps: Field.i32 },
    { x: 0, y: 0, rise: 0, jumps: 0 }
  );
  // The rules read what the player does, and no key.
  const Run = System.tick("pf/Run", function* () {
    const hero = yield* Hero.writes;
    const { delta } = yield* Time;
    hero.x += 6 * (yield* Move) * delta;
    if ((yield* Jump).pressed && hero.y === 0) {
      hero.rise = 12;
      hero.jumps += 1;
    }
    hero.rise -= 30 * delta;
    hero.y = Math.max(0, hero.y + hero.rise * delta);
    if (hero.y === 0) {
      hero.rise = 0;
    }
  });
  // What draws it flashes once for each press of the jump.
  const flashes: number[] = [];
  const Flash = System.frame("pf/Flash", function* () {
    if ((yield* Jump).pressed) {
      flashes.push((yield* Frame).count);
    }
  });
  // A settings menu: R, then the key the jump is to be, with the pad's B.
  const Menu = System.local(() => ({ asking: false }));
  const Settings = System.input("pf/Settings", function* () {
    const menu = yield* Menu;
    const { pressed } = yield* Input.Devices;
    if (!menu.asking) {
      menu.asking = pressed.includes("KeyR");
      return;
    }
    const key = pressed.find(Input.isKeyCode);
    if (key !== undefined) {
      yield* Input.rebind(Jump, [key, Input.padButton(0, 1)]);
      menu.asking = false;
    }
  });
  const Controls = Input.controls("pf/Controls", [Jump, Move]);
  const Platformer = App.define({
    plugins: [Controls],
    systems: [Run, Flash, Settings],
  });

  it.effect(
    "is rebound by code outside its systems, as a settings menu is, and keeps its keys in a setting across a reload",
    () =>
      Effect.gen(function* () {
        // The page keeps the jump's keys in a setting, in their JSON form.
        const JumpKeys = Setting.define(
          "pf/JumpKeys",
          Jump.schema,
          Jump.bindings
        );
        const store = Setting.makeMemory();
        // What a page does when its game starts: the keys it kept, applied.
        const start = Effect.fnUntraced(function* () {
          const game = yield* Test.make(Platformer, { seed: 3 });
          const settings = Input.settingsOf(game.app, Controls);
          yield* settings.rebind(Jump, yield* JumpKeys);
          return { game, settings };
        });
        const jumped = Effect.fnUntraced(function* (
          game: Effect.Success<ReturnType<typeof start>>["game"],
          code: Input.ButtonCode
        ) {
          const before = (yield* game.app.read(Hero)).jumps;
          game.input.tap(code);
          for (let i = 0; i < 60; i++) {
            yield* game.step();
          }
          return (yield* game.app.read(Hero)).jumps > before;
        });
        const { game, settings } = yield* start().pipe(
          Effect.provide(Setting.layer(store))
        );
        expect(yield* settings.bindingsOf(Jump)).toEqual(Jump.bindings);
        // The page's menu, which runs in no system, makes K the jump, and
        // keeps it. The game itself holds none of it.
        const hash = yield* hashOf(game.app);
        yield* settings.rebind(Jump, ["KeyK"]);
        yield* Setting.set(JumpKeys, ["KeyK"]).pipe(
          Effect.provide(Setting.layer(store))
        );
        expect(yield* hashOf(game.app)).toBe(hash);
        expect(store.get("pf/JumpKeys")).toBe('["KeyK"]');
        expect(yield* jumped(game, "KeyK")).toBe(true);
        expect(yield* jumped(game, "Space")).toBe(false);
        // A reload: a new app, given what the store kept.
        const next = yield* start().pipe(Effect.provide(Setting.layer(store)));
        expect(yield* next.settings.bindingsOf(Jump)).toEqual(["KeyK"]);
        expect(yield* jumped(next.game, "KeyK")).toBe(true);
        expect(yield* jumped(next.game, "Space")).toBe(false);
        // A kept text the schema refuses, a key that is none, is the keys
        // the control was declared with.
        const spelt = Setting.makeMemory({ "pf/JumpKeys": '["Spce"]' });
        expect(
          yield* Effect.provide(JumpKeys.asEffect(), Setting.layer(spelt))
        ).toEqual(Jump.bindings);
        // What the game's own menu, an input system, rebinds is what the
        // page's reads.
        expect(yield* settings.bindingsOf(Move)).toEqual(Move.bindings);
        game.input.tap("KeyR");
        yield* game.step();
        game.input.tap("KeyX");
        yield* game.step();
        expect(yield* settings.bindingsOf(Jump)).toEqual([
          "KeyX",
          Input.padButton(0, 1),
        ]);
        // It takes only the controls the plugin declares, and an app made
        // with the plugin.
        const Other = Input.button("pf/Other", ["KeyO"]);
        const refused = [
          // @ts-expect-error a control the plugin does not declare
          settings.rebind(Other, ["KeyO"]),
          settings.rebind(
            Move,
            // @ts-expect-error a stick is not bound to a list of codes
            ["KeyO"]
          ),
        ];
        expect(refused.length).toBe(2);
        const bare = yield* App.make(App.define({}));
        expect(() => Input.settingsOf(bare, Controls)).toThrow(
          'Input.settingsOf was given an app without the plugin "pf/Controls"'
        );
      })
  );

  it.effect(
    "runs and jumps from keys and a pad, is rebound while it runs, flashes once a jump, and replays to the same hash",
    () =>
      Effect.gen(function* () {
        flashes.length = 0;
        const game = yield* Test.make(Platformer, { seed: 3 });
        const hero = Effect.fnUntraced(function* () {
          const { jumps, x, y } = yield* game.app.read(Hero);
          return { jumps, x: Math.round(x * 1000) / 1000, y };
        });
        const steps = Effect.fnUntraced(function* (count: number) {
          for (let i = 0; i < count; i++) {
            yield* game.step();
          }
        });
        // Right for half a second with a key, then left with the pad's
        // stick halfway over.
        game.input.press("ArrowRight");
        yield* steps(30);
        game.input.release("ArrowRight");
        game.input.move(Input.padAxis(0, 0), -0.5);
        yield* steps(30);
        game.input.move(Input.padAxis(0, 0), 0);
        expect(yield* hero()).toEqual({ jumps: 0, x: 1.5, y: 0 });
        // A jump, drawn in three frames of its tick: one flash.
        game.input.press("Space");
        yield* game.step();
        yield* game.app.frame(0.5);
        yield* game.app.frame(0.9);
        game.input.release("Space");
        yield* steps(60);
        expect((yield* hero()).jumps).toBe(1);
        // The pad's A jumps too.
        game.input.tap(Input.padButton(0, 0));
        yield* steps(60);
        // The player makes X the jump: the space bar no longer jumps.
        game.input.tap("KeyR");
        yield* game.step();
        game.input.tap("KeyX");
        yield* game.step();
        game.input.tap("Space");
        yield* steps(60);
        expect(yield* hero()).toEqual({ jumps: 2, x: 1.5, y: 0 });
        game.input.tap("KeyX");
        yield* steps(60);
        game.input.tap(Input.padButton(0, 1));
        yield* steps(60);
        expect(yield* hero()).toEqual({ jumps: 4, x: 1.5, y: 0 });
        expect(flashes.length).toBe(4);
        // The recording plays the same game, with no devices and the
        // bindings the controls were declared with.
        const recording = yield* Replay.record(game.app);
        const again = yield* Replay.verify(recording, Platformer);
        expect(yield* hashOf(again)).toBe(yield* hashOf(game.app));
        const replayed = yield* again.read(Hero);
        expect(replayed.jumps).toBe(4);
      })
  );

  it.effect(
    "plays the same when each tick is run again, as a rollback session runs it, and still flashes once a jump",
    () =>
      Effect.gen(function* () {
        flashes.length = 0;
        const source = Input.makeManualSource();
        const test = yield* Session.syncTest(Platformer, { seed: 3 }).pipe(
          withSource(source)
        );
        const steps = Effect.fnUntraced(function* (count: number) {
          for (let i = 0; i < count; i++) {
            yield* test.tick(1 / 60);
            yield* test.frame();
          }
        });
        source.press("ArrowRight");
        yield* steps(20);
        source.release("ArrowRight");
        source.tap("Space");
        yield* steps(60);
        source.tap("KeyR");
        yield* steps(1);
        source.tap("KeyX");
        yield* steps(1);
        source.tap("KeyX");
        source.move(Input.padAxis(0, 0), -1);
        yield* steps(60);
        // Each tick ran twice to the same hash, system by system.
        expect(test.checked).toBe(142);
        const { jumps } = yield* test.app.read(Hero);
        expect([jumps, flashes.length]).toEqual([2, 2]);
      })
  );
});

describe("a source worked by hand", () => {
  it("says what is down, and what went down, went up or moved since it was last asked", () => {
    const source = Input.makeManualSource();
    expect(told(source.sample())).toEqual({
      down: [],
      pressed: [],
      released: [],
      axes: {},
      moved: [],
    });
    source.press("KeyA");
    source.press("KeyA");
    source.release("KeyB");
    source.move("PointerX", 0);
    source.move("PointerY", 3);
    expect(told(source.sample())).toEqual({
      down: ["KeyA"],
      pressed: ["KeyA"],
      released: [],
      axes: { PointerY: 3 },
      moved: ["PointerY"],
    });
    // Nothing since: the same picture, and nothing happened.
    expect(told(source.sample())).toEqual({
      down: ["KeyA"],
      pressed: [],
      released: [],
      axes: { PointerY: 3 },
      moved: [],
    });
    // Down, up and down again between two samples went down, and up.
    source.release("KeyA");
    source.press("KeyA");
    source.release("KeyA");
    source.press("KeyA");
    source.move("PointerY", 3);
    source.move("PointerY", 0);
    expect(told(source.sample())).toEqual({
      down: ["KeyA"],
      pressed: ["KeyA"],
      released: ["KeyA"],
      axes: { PointerY: 0 },
      moved: ["PointerY"],
    });
    source.press("Pad0Button1");
    source.press("Pointer0");
    source.sample();
    source.releaseAll((code) => !code.startsWith("Pad"));
    expect(told(source.sample())).toEqual({
      down: ["Pad0Button1"],
      pressed: [],
      released: ["KeyA", "Pointer0"],
      axes: { PointerY: 0 },
      moved: [],
    });
    source.releaseAll();
    expect(told(source.sample()).released).toEqual(["Pad0Button1"]);
    // A sample is not changed by what happens after it was taken.
    const kept = source.sample();
    source.press("KeyK");
    source.move("PointerX", 9);
    expect(told(kept)).toEqual({
      down: [],
      pressed: [],
      released: [],
      axes: { PointerY: 0 },
      moved: [],
    });
  });
});
