import { Cause, Data, Effect, Exit, Schema } from "effect";
import type { Scope } from "effect";
import { assert, describe, expect, expectTypeOf, it } from "vitest";

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
  Journal,
  Plugin,
  Query,
  Random,
  Save,
  Singleton,
  Stage,
  State,
  System,
  Time,
  World,
  readSnapshot,
} from "../src/index";
import type { BuiltIn } from "../src/Services";

const Ship = Component.define("in/Ship", { x: Field.f32, shots: Field.i32 });
const Ships = Query.all(Ship).pipe(Query.writes(Ship));
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

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): A =>
  Effect.runSync(Effect.scoped(effect));

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
const Steer = System.make("Steer", function* () {
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
  setup: Effect.map(Commands, (commands) => {
    commands.spawn(Ship.of({ x: 0, shots: 0 }));
  }),
});
const ship = (app: App.Any): { x: number; shots: number } => {
  let found = { x: Number.NaN, shots: Number.NaN };
  app.world.view(Ships).each((one) => {
    found = { x: one.x, shots: one.shots };
  });
  return found;
};
const reports = (app: App.Any): unknown[] =>
  app.actionLog
    .filter(
      (entry): entry is Action.Logged =>
        !Action.isCheckpoint(entry) && entry.name === "arcadekit/Input.Report"
    )
    .map((entry) => entry.payload);

describe("the input stage", () => {
  it("runs before a tick, by whoever steps the app or else by the tick itself, in order, and not in the frame", () => {
    run(
      Effect.gen(function* () {
        const ran: string[] = [];
        const note = (name: string, stage: System.Stage) =>
          System.make(name, function* () {
            ran.push(name);
          }).pipe(System.inStage(stage));
        const Second = note("Second", "input");
        const First = note("First", "input");
        const Sometimes = note("Sometimes", "input").pipe(
          System.runIf(State.is(Phase, "paused"))
        );
        const app = yield* App.make(
          App.define({
            systems: [
              First,
              note("Tick", "update"),
              Second,
              note("Draw", "frame"),
              Sometimes,
            ],
          })
        );
        expect(app.inputOrder).toEqual(["First", "Second", "Sometimes"]);
        expect(app.systemOrder).toEqual(["Tick"]);
        expect(app.frameOrder).toEqual(["Draw"]);
        // A tick hears the devices first. Nobody ran the stage, so the
        // tick does; a frame never does.
        app.tick(1);
        app.frame(0);
        expect(ran).toEqual(["First", "Second", "Tick", "Draw"]);
        // Run by whoever steps the app, as a driver does, it is not run
        // again by the tick that follows, and is by the one after that.
        ran.length = 0;
        app.input();
        expect(ran).toEqual(["First", "Second"]);
        app.tick(1);
        app.tick(1);
        expect(ran).toEqual([
          "First",
          "Second",
          "Tick",
          "First",
          "Second",
          "Tick",
        ]);
        // A tick told to read nothing runs none of it, as a replay's does
        // not: and what it did not hear is not owed to it later.
        ran.length = 0;
        app.tick(1, { input: false });
        expect(Exit.isSuccess(app.tickExit(1, { input: false }))).toBe(true);
        expect(ran).toEqual(["Tick", "Tick"]);
        app.tick(1, { input: true });
        expect(ran).toEqual(["Tick", "Tick", "First", "Second", "Tick"]);
        // Heard by hand before a tick that reads nothing, the next tick
        // hears for itself all the same.
        ran.length = 0;
        app.input();
        app.tick(1, { input: false });
        app.tick(1);
        expect(ran).toEqual([
          "First",
          "Second",
          "Tick",
          "First",
          "Second",
          "Tick",
        ]);
        // A condition is asked there as anywhere.
        app.world.singleton(Phase).next = "paused";
        app.tick(1);
        ran.length = 0;
        expect(Exit.isSuccess(app.inputExit())).toBe(true);
        expect(ran).toEqual(["First", "Second", "Sometimes"]);
        // An app with no input stage is driven as before.
        const plain = yield* App.make(
          App.define({ systems: [note("Other", "update")] })
        );
        expect(plain.inputOrder).toEqual([]);
        plain.input();
      })
    );
  });

  it("is told what the devices say: one sample for every system of a run, and a new one the next", () => {
    const source = Input.makeManualSource();
    run(
      Effect.gen(function* () {
        const seen: unknown[] = [];
        const A = System.make("A", function* () {
          seen.push(told(yield* Input.Devices));
        }).pipe(System.inStage("input"));
        const B = System.make("B", function* () {
          // Pressed while the stage runs: not in this run's sample.
          source.press("KeyZ");
          seen.push(told(yield* Input.Devices));
        }).pipe(System.inStage("input"));
        const app = yield* App.make(App.define({ systems: [A, B] }));
        source.press("KeyA");
        source.tap("Space");
        source.move(Input.pointerX, 12.5);
        app.input();
        const first = {
          down: ["KeyA"],
          pressed: ["KeyA", "Space"],
          released: ["Space"],
          axes: { PointerX: 12.5 },
          moved: ["PointerX"],
        };
        expect(seen).toEqual([first, first]);
        source.release("KeyA");
        app.input();
        const second = {
          down: ["KeyZ"],
          pressed: ["KeyZ"],
          released: ["KeyA"],
          axes: { PointerX: 12.5 },
          moved: [],
        };
        expect(seen.slice(2)).toEqual([second, second]);
      }).pipe(withSource(source))
    );
  });

  it("has no devices unless a source is provided", () => {
    run(
      Effect.gen(function* () {
        const seen: unknown[] = [];
        const A = System.make("A", function* () {
          seen.push(told(yield* Input.Devices));
        }).pipe(System.inStage("input"));
        const app = yield* App.make(App.define({ systems: [A] }));
        app.input();
        expect(seen).toEqual([
          { down: [], pressed: [], released: [], axes: {}, moved: [] },
        ]);
      })
    );
  });

  it("does not read the devices when no system would hear of them", () => {
    let samples = 0;
    const inner = Input.makeManualSource();
    const source: Input.Listener = {
      sample() {
        samples++;
        return inner.sample();
      },
    };
    run(
      Effect.gen(function* () {
        const Tick = System.make("Tick", function* () {});
        const app = yield* App.make(App.define({ systems: [Tick] }));
        app.input();
        app.tick(1);
        expect(samples).toBe(0);
        const Listen = System.make("Listen", function* () {
          yield* Input.Devices;
        }).pipe(System.inStage("input"));
        const listening = yield* App.make(App.define({ systems: [Listen] }));
        listening.input();
        listening.input();
        expect(samples).toBe(2);
      }).pipe(withSource(source))
    );
  });

  it("keeps the devices from the simulation and from what draws it", () => {
    run(
      Effect.gen(function* () {
        for (const stage of ["update", "frame"] as const) {
          const Peek = System.make("Peek", function* () {
            return (yield* Input.Devices).down.size > 0 ? undefined : undefined;
          }).pipe(System.inStage(stage));
          const app = yield* App.make(App.define({ systems: [Peek] }));
          const peek = (): void =>
            stage === "frame" ? app.frame(0) : app.tick(1);
          expect(peek, stage).toThrow(
            /Input\.Devices was read outside the input stage/
          );
          expect(peek, stage).toThrow(/Input\.Keyboard/);
        }
        // And the input stage is not told about a frame.
        const Blink = System.make("Blink", function* () {
          return (yield* Frame).alpha > 0 ? undefined : undefined;
        }).pipe(System.inStage("input"));
        const app = yield* App.make(App.define({ systems: [Blink] }));
        expect(() => app.input()).toThrow(
          /Frame was read by a system of the input stage/
        );
        // Every field of both says so.
        for (const field of ["pressed", "released", "axes", "moved"] as const) {
          const Peek = System.make("Peek", function* () {
            return (yield* Input.Devices)[field] === undefined
              ? undefined
              : undefined;
          });
          const one = yield* App.make(App.define({ systems: [Peek] }));
          expect(() => one.tick(1), field).toThrow(/outside the input stage/);
        }
        for (const field of ["delta", "count"] as const) {
          const Peek = System.make("Peek", function* () {
            return (yield* Frame)[field] === 0 ? undefined : undefined;
          }).pipe(System.inStage("input"));
          const one = yield* App.make(App.define({ systems: [Peek] }));
          expect(() => one.input(), field).toThrow(/of the input stage/);
        }
      })
    );
  });

  it("cannot change the game: whatever would throws, and names what did", () => {
    const Pinged = Event.define("in/Pinged", Schema.Struct({}));
    const Bump = Action.define("in/Bump", Schema.Struct({}));
    const bump = Action.handler(Bump, function* () {
      (yield* Score).points += 1;
    });
    const attempts: Record<string, Effect.Effect<unknown, never, BuiltIn>> = {
      'assignment to "in/Ship.x"': Effect.map(Ships, (ships) =>
        ships.each((one) => {
          one.x = 99;
        })
      ),
      "World.set()": Effect.map(World, (world) =>
        world.set(world.view(Ships).entities()[0]!, Ship, { x: 99 })
      ),
      "A spawn": Effect.map(Commands, (commands) => commands.spawn(Ship)),
      'singleton "in/Score"': Effect.map(Score, (score) => {
        score.points = 1;
      }),
      'singleton "in/Phase"': Effect.map(Phase, (phase) => phase.set("paused")),
      'event "in/Pinged" was emitted in the frame stage or the input stage':
        Effect.map(Pinged, (pinged) => pinged.emit({})),
      "A draw from world.random": Effect.map(World, (world) =>
        world.random.next()
      ),
    };
    for (const [what, attempt] of Object.entries(attempts)) {
      run(
        Effect.gen(function* () {
          const Vandal = System.make("Vandal", function* () {
            yield* attempt;
          }).pipe(System.inStage("input"));
          const app = yield* App.make(
            App.define({ handlers: [bump], systems: [Vandal] }),
            { checkpointEvery: 1, seed: 3 }
          );
          app.world.spawn(Ship.of({ x: 1, shots: 0 }));
          app.tick(1, { input: false });
          const before = app.world.hash();
          expect(() => app.input(), what).toThrow(what);
          expect(app.world.hash(), what).toBe(before);
          expect(app.commands.size, what).toBe(0);
          expect(app.events.pending(Pinged), what).toBe(0);
          // And the app is not left frozen, or in the middle of the stage.
          expect(app.world.frozen).toBe(false);
          app.tick(1);
          expect(Exit.isFailure(app.inputExit()), what).toBe(true);
        })
      );
    }
    // Nor can it be reached around: the app says where it is.
    run(
      Effect.gen(function* () {
        let app: App.App<never, typeof bump> | undefined;
        let reach: () => unknown = () => undefined;
        const Reach = System.make("Reach", function* () {
          reach();
        }).pipe(System.inStage("input"));
        app = yield* App.make(
          App.define({ handlers: [bump], systems: [Reach] })
        );
        const made = app;
        reach = () => made.dispatch(Bump, {});
        expect(() => made.input()).toThrow(
          /dispatch\("in\/Bump"\) was called during the input stage/
        );
        reach = () => made.tick(1);
        expect(() => made.input()).toThrow(
          /App\.tick was called from inside a run of the input stage/
        );
        reach = () => made.input();
        expect(() => made.input()).toThrow(
          /App\.input was called from inside a run of the input stage/
        );
        reach = () => made.frame(0);
        expect(() => made.input()).toThrow(
          /App\.frame was called from inside a run of the input stage/
        );
        reach = () => made.save();
        expect(() => made.input()).toThrow(/save\(\) was called during/);
        reach = () => undefined;
        made.input();
        expect(made.world.singleton(Score).points).toBe(0);
        // And the input stage is not run from inside a tick.
        let nested: App.Any | undefined;
        const Nested = System.make("Nested", function* () {
          nested?.input();
        });
        nested = yield* App.make(App.define({ systems: [Nested, Reach] }));
        expect(() => nested!.tick(1)).toThrow(
          /App\.input was called from inside a tick/
        );
      })
    );
  });

  it("is checked by verifyFrames, which names the system that wrote through raw columns", () => {
    run(
      Effect.gen(function* () {
        const Scribble = System.make("Scribble", function* () {
          (yield* Ships).eachChunk((start, end, ships) => {
            for (let i = start; i < end; i++) {
              ships.x[i] = 99;
            }
          });
        }).pipe(System.inStage("input"));
        const app = yield* App.make(App.define({ systems: [Scribble] }), {
          verifyFrames: true,
        });
        app.world.spawn(Ship.of({ x: 1, shots: 0 }));
        const exit = app.inputExit();
        expect(Exit.isFailure(exit)).toBe(true);
        const error = Cause.squash(
          (exit as Exit.Failure<void, never>).cause
        ) as Stage.FrameChangedWorld;
        expect(error).toBeInstanceOf(Stage.FrameChangedWorld);
        expect(error.stage).toBe("input");
        expect(error.system).toBe("Scribble");
        expect(error.message).toMatch(/^The input stage changed the world/);
        expect(error.message).toMatch(/reads the devices before a tick/);
        // A frame system that does the same is still called a frame system.
        const Smudge = System.make("Smudge", function* () {
          (yield* Ships).eachChunk((start, end, ships) => {
            for (let i = start; i < end; i++) {
              ships.x[i] = 7;
            }
          });
        }).pipe(System.inStage("frame"));
        const drawn = yield* App.make(App.define({ systems: [Smudge] }), {
          verifyFrames: true,
        });
        drawn.world.spawn(Ship.of({ x: 1, shots: 0 }));
        const smudged = Cause.squash(
          (drawn.frameExit(0) as Exit.Failure<void, never>).cause
        ) as Stage.FrameChangedWorld;
        expect(smudged.stage).toBe("frame");
        expect(smudged.message).toMatch(
          /^The frame stage changed the world: its hash was not the same after system "Smudge" ran in frame 1 as before/
        );
      })
    );
  });

  it("is not tripped by verifyFrames when a system between ticks issues an action, which the world's hash still covers", () => {
    run(
      Effect.gen(function* () {
        const Bump = Action.define(
          "in/VerifiedBump",
          Schema.Struct({ by: Schema.Int })
        );
        const bump = Action.handler(Bump, function* ({ by }) {
          (yield* Score).points += by;
        });
        const Press = System.make("Press", function* () {
          (yield* Action.Actions).enqueue(Bump, { by: 2 });
        }).pipe(System.inStage("input"));
        const Point = System.make("Point", function* () {
          (yield* Action.Actions).enqueue(Bump, { by: 3 });
        }).pipe(System.inStage("frame"));
        const app = yield* App.make(
          App.define({ handlers: [bump], systems: [Press, Point] }),
          { verifyFrames: true }
        );
        const before = app.world.hash();
        expect(Exit.isSuccess(app.inputExit())).toBe(true);
        expect(Exit.isSuccess(app.frameExit(0))).toBe(true);
        expect(app.world.hash()).not.toBe(before);
        app.tick(1);
        expect(app.world.singleton(Score).points).toBe(5);
      })
    );
  });

  it("issues actions that are logged as input from outside and applied at the start of the next tick", () => {
    const source = Input.makeManualSource();
    run(
      Effect.gen(function* () {
        const Bump = Action.define(
          "in/Bump",
          Schema.Struct({ by: Schema.Int })
        );
        const bump = Action.handler(Bump, function* ({ by }) {
          (yield* Score).points += by;
        });
        const Press = System.make("Press", function* () {
          const devices = yield* Input.Devices;
          if (devices.pressed.includes("Enter")) {
            (yield* Action.Actions).enqueue(Bump, { by: 5 });
          }
        }).pipe(System.inStage("input"));
        const seen: number[] = [];
        const Look = System.make("Look", function* () {
          seen.push((yield* Score).points);
        });
        const app = yield* App.make(
          App.define({ handlers: [bump], systems: [Press, Look] }),
          { checkpointEvery: 0 }
        );
        source.press("Enter");
        app.input();
        expect(app.world.singleton(Score).points).toBe(0);
        expect(app.actionLog).toEqual([
          { tick: 0, name: "in/Bump", payload: { by: 5 }, queued: true },
        ]);
        app.tick(1);
        expect(seen).toEqual([5]);
        // Held is not pressed again.
        app.input();
        app.tick(1);
        expect(seen).toEqual([5, 5]);
        expect(app.actionLog.length).toBe(1);
      }).pipe(withSource(source))
    );
  });

  it("is run by the fixed step just before each tick, and not at all when no tick is due", () => {
    const source = Input.makeManualSource();
    run(
      Effect.gen(function* () {
        const order: string[] = [];
        const Listen = System.make("Listen", function* () {
          order.push(`input ${told(yield* Input.Devices).pressed.join("+")}`);
        }).pipe(System.inStage("input"));
        const Tick = System.make("Tick", function* () {
          order.push(`tick ${(yield* Time).tick}`);
        });
        const Draw = System.make("Draw", function* () {
          order.push("frame");
        }).pipe(System.inStage("frame"));
        const app = yield* App.make(
          App.define({ systems: [Listen, Tick, Draw] })
        );
        const step = Driver.fixedStep(app, { hz: 10 });
        // Frames of 40 ms against ticks of 100 ms.
        source.press("KeyA");
        step(0.04);
        source.tap("KeyB");
        step(0.04);
        expect(order).toEqual(["frame", "frame"]);
        // The tick that comes due hears what was pressed in every frame since.
        step(0.04);
        expect(order.slice(2)).toEqual(["input KeyA+KeyB", "tick 1", "frame"]);
        // A long frame reads the devices before each of its ticks.
        order.length = 0;
        source.press("KeyC");
        step(0.2);
        expect(order).toEqual([
          "input KeyC",
          "tick 2",
          "input ",
          "tick 3",
          "frame",
        ]);
      }).pipe(withSource(source))
    );
  });

  it("reads events and changes from a place of its own, which is not saved", () => {
    run(
      Effect.gen(function* () {
        const Landed = Event.define(
          "in/Landed",
          Schema.Struct({ at: Schema.Int })
        );
        const Land = System.make("Land", function* () {
          (yield* Landed).emit({ at: (yield* Time).tick });
        });
        const heard: number[] = [];
        const also: number[] = [];
        const drawn: number[] = [];
        const hear = (name: string, into: number[], stage: System.Stage) =>
          System.make(name, function* () {
            for (const landed of (yield* Landed).read()) {
              into.push(landed.at);
            }
          }).pipe(System.inStage(stage));
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
          app.input();
          app.tick(1);
          plain.tick(1);
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
        step(0.1);
        step(0.3);
        expect(drawn).toEqual([1, 2, 3, 4]);
        // The game cannot tell that its devices are read.
        expect(app.world.hash()).toBe(plain.world.hash());
        const save = app.save();
        const bare = plain.save();
        assert(Exit.isSuccess(save) && Exit.isSuccess(bare));
        expect(waitingIn(save.value)).toEqual(waitingIn(bare.value));
      })
    );
  });

  it("hears what a tick's actions emitted, and that an action it issued was refused", () => {
    class TooMuch extends Data.TaggedError("TooMuch")<{}> {}
    const Done = Event.define("in/Done", Schema.Struct({ by: Schema.Int }));
    const Try = Action.define("in/Try", Schema.Struct({ by: Schema.Int }));
    const attempt = Action.handler(Try, function* ({ by }) {
      if (by > 5) {
        return yield* new TooMuch();
      }
      (yield* Done).emit({ by });
    });
    const hear = (
      name: string,
      stage: System.Stage,
      done: number[],
      refused: string[]
    ) =>
      System.make(name, function* () {
        for (const event of (yield* Done).read()) {
          done.push(event.by);
        }
        for (const event of (yield* Action.Rejected).read()) {
          refused.push(`${event.action} ${(event.error as TooMuch)._tag}`);
        }
      }).pipe(System.inStage(stage));
    run(
      Effect.gen(function* () {
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
            app.input();
            app.enqueue(Try, { by });
            app.tick(1);
            app.frame(0);
          }
        }
        alone.input();
        together.input();
        // Each event once, the first tick's among them, and the refusal.
        expect(heard).toEqual([1, 3]);
        expect(refused).toEqual(["in/Try TooMuch"]);
        expect(both).toEqual([1, 3]);
        expect(drawn).toEqual([1, 3]);
        expect(drawnRefused).toEqual(["in/Try TooMuch"]);
        expect(onlyDrawn).toEqual([1, 3]);
        // And the game cannot tell that anyone was listening.
        expect(alone.world.hash()).toBe(bare.world.hash());
        const saves = [alone, together, bare].map((app) => app.save());
        const events = saves.map((save) => {
          assert(Exit.isSuccess(save));
          return waitingIn(save.value);
        });
        expect(events[0]).toEqual(events[2]);
        expect(events[1]).toEqual(events[2]);
        // Heard, they are kept no longer.
        for (let i = 0; i < 3; i++) {
          alone.input();
          alone.tick(1);
        }
        expect(alone.events.pending(Done)).toBe(0);
        expect(heard).toEqual([1, 3]);
      })
    );
  });

  it("keeps an event until the stages have had their chance at it, and no longer", () => {
    const Done = Event.define("in/Once", Schema.Struct({ at: Schema.Int }));
    const Emit = Action.define("in/EmitOnce", Schema.Struct({}));
    const emit = Action.handler(Emit, function* () {
      (yield* Done).emit({ at: (yield* Time).tick + 1 });
    });
    // A system that first listens late hears what is still kept: only
    // what its stage has not yet had its chance at.
    const late = (
      stage: System.Stage,
      listening: () => boolean,
      heard: number[]
    ) =>
      System.make("Late", function* () {
        if (listening()) {
          for (const event of (yield* Done).read()) {
            heard.push(event.at);
          }
        }
      }).pipe(System.inStage(stage));
    run(
      Effect.gen(function* () {
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
            app.input();
            app.enqueue(Emit, {});
            app.tick(1);
            app.frame(0);
          }
          app.input();
          // The input stage runs before a tick, so what it has not had
          // its chance at is the tick before; the frame stage runs after.
          expect(heard, stage).toEqual(stage === "input" ? [5, 6] : [6]);
        }
      })
    );
  });

  it("keeps events for a stage that is late, and stops for one that is never run, as a replay never runs it", () => {
    const Done = Event.define("in/Kept", Schema.Struct({}));
    const Emit = Action.define("in/Emit", Schema.Struct({}));
    const emit = Action.handler(Emit, function* () {
      (yield* Done).emit({});
    });
    run(
      Effect.gen(function* () {
        let heard = 0;
        const Hear = System.make("Hear", function* () {
          heard += (yield* Done).read().length;
        }).pipe(System.inStage("input"));
        const ticked = function* (ticks: number) {
          const app = yield* App.make(
            App.define({ handlers: [emit], systems: [Hear] })
          );
          for (let i = 0; i < ticks; i++) {
            app.enqueue(Emit, {});
            // As a replay ticks: reading nothing.
            app.tick(1, { input: false });
          }
          return app;
        };
        // Late by a hundred ticks: every one of their events is there.
        const late = yield* ticked(100);
        late.input();
        expect(heard).toBe(100);
        // Never run in seven hundred, as in a replay: the app has taken
        // the stage to be gone, and keeps nothing for it.
        heard = 0;
        const gone = yield* ticked(700);
        gone.input();
        expect(heard).toBe(0);
        // Run again, it hears again from then on.
        for (let i = 0; i < 3; i++) {
          gone.enqueue(Emit, {});
          gone.tick(1);
          gone.input();
        }
        expect(heard).toBe(3);
      })
    );
  });

  it("is run by a tick that nobody ran it for: a game stepped by hand hears its keys with no more than a tick", () => {
    const source = Input.makeManualSource();
    run(
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ plugins: [Flying] }), {
          checkpointEvery: 0,
        });
        // No `app.input()` anywhere.
        source.press("ArrowRight");
        app.tick(1);
        app.tick(1);
        expect(ship(app).x).toBe(20);
        source.release("ArrowRight");
        source.tap("Space");
        app.tick(1);
        expect(ship(app)).toEqual({ x: 20, shots: 1 });
        // Each tick read the devices once, and reported what had changed.
        expect(reports(app)).toEqual([
          { down: ["ArrowRight"] },
          { up: ["ArrowRight"], tapped: ["Space"] },
        ]);
        // Under a driver, which runs the stage itself before each tick,
        // it is not run a second time: one report for one change.
        const step = Driver.fixedStep(app, { hz: 10 });
        source.press("ArrowLeft");
        step(0.3);
        expect(app.time.tick).toBe(6);
        expect(reports(app).slice(2)).toEqual([{ down: ["ArrowLeft"] }]);
        expect(ship(app).x).toBeCloseTo(17, 5);
      }).pipe(withSource(source))
    );
  });

  it("stops the tick that ran it when it fails: the tick does not run, and the next hears first again", () => {
    class NoKeyboard extends Data.TaggedError("NoKeyboard")<{}> {}
    run(
      Effect.gen(function* () {
        let broken = true;
        let ran = 0;
        const Read = System.make("Read", function* () {
          ran++;
          if (broken) {
            return yield* new NoKeyboard();
          }
        }).pipe(System.inStage("input"));
        let ticked = 0;
        const Tick = System.make("Tick", function* () {
          ticked++;
        });
        const app = yield* App.make(App.define({ systems: [Read, Tick] }));
        const exit = app.tickExit(1);
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(
          NoKeyboard
        );
        expect([ran, ticked, app.time.tick]).toEqual([1, 0, 0]);
        expect(() => app.tick(1)).toThrow(NoKeyboard);
        expect([ran, ticked, app.time.tick]).toEqual([2, 0, 0]);
        // Told to read nothing, the tick runs.
        app.tick(1, { input: false });
        expect([ran, ticked, app.time.tick]).toEqual([2, 1, 1]);
        broken = false;
        app.tick(1);
        expect([ran, ticked, app.time.tick]).toEqual([3, 2, 2]);
      })
    );
  });

  it("is not run by a replay, whatever the devices of the machine it is replayed on say", () => {
    const source = Input.makeManualSource();
    let recording: Journal.Recording | undefined;
    let hash = 0;
    run(
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ plugins: [Flying] }), {
          checkpointEvery: 1,
        });
        source.press("ArrowRight");
        app.tick(1);
        app.tick(1);
        recording = app.record();
        hash = app.world.hash();
        expect(ship(app).x).toBe(20);
      }).pipe(withSource(source))
    );
    // Replayed where another key is held, and a third is pressed.
    const here = Input.makeManualSource();
    here.press("ArrowLeft");
    here.tap("Space");
    run(
      Effect.gen(function* () {
        const again = yield* Journal.replay(recording!, (start) =>
          App.make(App.define({ plugins: [Flying] }), {
            ...start,
            checkpointEvery: 1,
          })
        );
        expect(again.world.hash()).toBe(hash);
        expect(ship(again)).toEqual({ x: 20, shots: 0 });
        expect(reports(again)).toEqual([{ down: ["ArrowRight"] }]);
        // Played on from there, by hand, it hears the machine it is on.
        again.tick(1);
        expect(ship(again).shots).toBe(1);
      }).pipe(withSource(here))
    );
  });

  it("gives a system's failure back typed, and a stopped app runs none of it", () => {
    class NoKeyboard extends Data.TaggedError("NoKeyboard")<{}> {}
    run(
      Effect.gen(function* () {
        const Fail = System.make("Fail", function* () {
          return yield* new NoKeyboard();
        }).pipe(System.inStage("input"));
        const app = yield* App.make(App.define({ systems: [Fail] }));
        const exit = app.inputExit();
        expect(Exit.isFailure(exit)).toBe(true);
        expect(
          Cause.squash((exit as Exit.Failure<void, NoKeyboard>).cause)
        ).toEqual(new NoKeyboard());
        expect(() => app.input()).toThrow(NoKeyboard);
        expect(app.world.frozen).toBe(false);
        // A system that waits has not finished within the stage.
        const Wait = System.make("Wait", function* () {
          yield* Effect.never;
        }).pipe(System.inStage("input"));
        const waiting = yield* App.make(App.define({ systems: [Wait] }));
        expect(() => waiting.input()).toThrow(
          /System "Wait" did not finish within the input stage/
        );
        expect(waiting.world.frozen).toBe(false);
      })
    );
  });

  it("refuses a hook, which runs when a tick enters a state", () => {
    run(
      Effect.gen(function* () {
        const Hook = System.make("Hook", function* () {}).pipe(
          System.inStage("input"),
          State.onEnter(Phase, "paused")
        );
        const exit = yield* Effect.exit(
          App.make(App.define({ systems: [Hook] }))
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(
          (Cause.squash((exit as Exit.Failure<never, never>).cause) as Error)
            .message
        ).toMatch(/System "Hook" is a hook and is in the input stage/);
      })
    );
  });

  it("draws its random numbers from a generator that is not the world's", () => {
    run(
      Effect.gen(function* () {
        const drawn: number[] = [];
        const Jitter = System.make("Jitter", function* () {
          drawn.push((yield* Random).next());
        }).pipe(System.inStage("input"));
        const app = yield* App.make(App.define({ systems: [Jitter] }), {
          seed: 5,
        });
        const state = Array.from(app.world.random.state);
        app.input();
        app.input();
        expect(new Set(drawn).size).toBe(2);
        expect(Array.from(app.world.random.state)).toEqual(state);
      })
    );
  });
});

describe("the picture of the devices in the world", () => {
  it("says what is held, and what went down or up in this tick, the same to every system", () => {
    const source = Input.makeManualSource();
    run(
      Effect.gen(function* () {
        const seen: string[] = [];
        const look = (name: string) =>
          System.make(name, function* () {
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
        const step = (): void => {
          app.input();
          app.tick(1);
        };
        step();
        source.press("KeyA");
        step();
        step();
        source.release("KeyA");
        step();
        step();
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
        step();
        step();
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
        app.input();
        source.release("KeyA");
        app.input();
        app.tick(1);
        app.tick(1);
        expect(seen).toEqual([
          "First 8: pressed released",
          "Second 8: pressed released",
          "First 9:",
          "Second 9:",
        ]);
        // A key let go and pressed again at once: held, and pressed anew.
        source.press("KeyA");
        step();
        source.release("KeyA");
        app.input();
        source.press("KeyA");
        app.input();
        seen.length = 0;
        app.tick(1);
        expect(seen[0]).toBe("First 11: down pressed released");
        // A held key let go and pressed again between two readings of the
        // devices, with no tick between: the same. It went up, it went
        // down, and it is held.
        source.release("KeyA");
        source.press("KeyA");
        seen.length = 0;
        step();
        step();
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
        step();
        step();
        expect(seen).toEqual([
          "First 14: pressed released",
          "Second 14: pressed released",
          "First 15:",
          "Second 15:",
        ]);
        expect(reports(app).at(-1)).toEqual({ up: ["KeyA"], tapped: ["KeyA"] });
        // Read twice with no tick between, what did not change is said once.
        const said = reports(app).length;
        source.move(Input.pointerX, 5);
        source.press("KeyB");
        app.input();
        app.input();
        app.input();
        expect(reports(app).slice(said)).toEqual([
          { down: ["KeyB"], axes: { PointerX: 5 } },
        ]);
      }).pipe(withSource(source))
    );
  });

  it("has the pointer and the gamepads, each by its own name", () => {
    const source = Input.makeManualSource();
    run(
      Effect.gen(function* () {
        let seen: unknown;
        const Look = System.make("Look", function* () {
          const pointer = yield* Input.Pointer;
          const pad = yield* Input.Gamepad();
          const other = yield* Input.Gamepad(1);
          const keys = yield* Input.Keyboard;
          seen = {
            at: [pointer.x, pointer.y],
            main: [pointer.down(), pointer.pressed(), pointer.released()],
            second: [pointer.down(2), pointer.pressed(2), pointer.released(2)],
            stick: [pad.axis(0), pad.axis(1), pad.axis(2)],
            a: [pad.down(0), pad.pressed(0), pad.released(0)],
            other: [other.axis(0), other.down(0), other.pressed(3)],
            key: keys.down("Pointer0"),
          };
        });
        const app = yield* App.make(
          App.define({ plugins: [Input.plugin], systems: [Look] })
        );
        app.input();
        app.tick(1);
        expect(seen).toEqual({
          at: [0, 0],
          main: [false, false, false],
          second: [false, false, false],
          stick: [0, 0, 0],
          a: [false, false, false],
          other: [0, false, false],
          key: false,
        });
        source.move(Input.pointerX, 120);
        source.move(Input.pointerY, 45.5);
        source.press(Input.pointerButton(2));
        source.move(Input.padAxis(0, 1), -0.75);
        source.press(Input.padButton(0, 0));
        source.move(Input.padAxis(1, 0), 0.5);
        source.press(Input.padButton(1, 3));
        app.input();
        app.tick(1);
        expect(seen).toEqual({
          at: [120, 45.5],
          main: [false, false, false],
          second: [true, true, false],
          stick: [0, -0.75, 0],
          a: [true, true, false],
          other: [0.5, false, true],
          key: false,
        });
        source.release(Input.pointerButton(2));
        source.press(Input.pointerButton());
        source.move(Input.padAxis(0, 1), 0);
        source.release(Input.padButton(0, 0));
        app.input();
        app.tick(1);
        expect(seen).toEqual({
          at: [120, 45.5],
          main: [true, true, false],
          second: [false, false, true],
          stick: [0, 0, 0],
          a: [false, false, true],
          other: [0.5, false, false],
          key: true,
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
      }).pipe(withSource(source))
    );
  });

  it("goes through the action log, so a replay needs no devices at all", () => {
    const source = Input.makeManualSource();
    const { hashes, played, text, ticks } = run(
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ plugins: [Flying] }), {
          checkpointEvery: 1,
          seed: 9,
        });
        const step = Driver.fixedStep(app, { hz: 10 });
        const tickHashes: number[] = [];
        const frame = (): void => {
          step(0.1);
          tickHashes.push(app.world.hash());
        };
        frame();
        source.press("ArrowRight");
        frame();
        frame();
        source.press("Space");
        frame();
        source.release("ArrowRight");
        source.release("Space");
        source.press("ArrowLeft");
        source.move(Input.pointerX, 33);
        frame();
        source.tap("Space");
        frame();
        frame();
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
          text: Journal.encode(app.record()),
          played: ship(app),
          ticks: app.time.tick,
        };
      }).pipe(withSource(source))
    );
    // Right for 3 ticks, left for 3, a tenth of a second each; two shots.
    expect(played.x).toBeCloseTo(0, 5);
    expect(played.shots).toBe(2);
    expect(ticks).toBe(7);

    // The replay is given no source, and its input stage is never run.
    run(
      Effect.gen(function* () {
        const decoded = Journal.decode(text);
        assert(Exit.isSuccess(decoded));
        const recording = decoded.value;
        const entries = recording.log;
        const again = yield* Journal.replay(recording, (start) =>
          App.make(App.define({ plugins: [Flying] }), {
            ...start,
            checkpointEvery: 1,
          })
        );
        expect(ship(again)).toEqual(played);
        expect(again.world.hash()).toBe(hashes.at(-1));
        // Checked against every tick's checkpoint on the way.
        expect(
          entries.filter((entry) => Action.isCheckpoint(entry)).length
        ).toBe(ticks + 1);
        // A log that says another key was held is another game.
        const altered = entries.map((entry) =>
          !Action.isCheckpoint(entry) &&
          JSON.stringify(entry.payload) === '{"down":["ArrowRight"]}'
            ? { ...entry, payload: { down: ["ArrowLeft"] } }
            : entry
        );
        const alteredRecording = { ...recording, log: altered };
        const diverged = yield* Effect.flip(
          Journal.replay(alteredRecording, (start) =>
            App.make(App.define({ plugins: [Flying] }), {
              ...start,
              checkpointEvery: 1,
            })
          )
        );
        expect(diverged).toBeInstanceOf(Journal.ReplayDiverged);
      })
    );
  });

  it("is untouched while nothing changes: no action, and the hash of a game that has no input", () => {
    const source = Input.makeManualSource();
    run(
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ plugins: [Flying] }), {
          checkpointEvery: 0,
        });
        const Bare = Plugin.make("Bare", {
          setup: Effect.map(Commands, (commands) => {
            commands.spawn(Ship.of({ x: 0, shots: 0 }));
          }),
        });
        const bare = yield* App.make(App.define({ plugins: [Bare] }), {
          checkpointEvery: 0,
        });
        for (let i = 0; i < 3; i++) {
          app.input();
          app.tick(1);
          bare.tick(1);
        }
        expect(app.actionLog).toEqual([]);
        expect(app.world.hash()).toBe(bare.world.hash());
        source.press("KeyQ");
        app.input();
        app.tick(1);
        // Held still: one report, however long it is held.
        for (let i = 0; i < 5; i++) {
          app.input();
          app.tick(1);
        }
        expect(reports(app)).toEqual([{ down: ["KeyQ"] }]);
        expect(app.world.hash()).not.toBe(bare.world.hash());
      }).pipe(withSource(source))
    );
  });

  it("holds the same data for the same buttons, in whatever order they went down", () => {
    run(
      Effect.gen(function* () {
        const one = yield* App.make(App.define({ plugins: [Input.plugin] }));
        const two = yield* App.make(App.define({ plugins: [Input.plugin] }));
        one.dispatch(Input.Report, {
          down: ["KeyB", "KeyA"],
          axes: { PointerY: 2, PointerX: 1 },
        });
        two.dispatch(Input.Report, {
          down: ["KeyA", "KeyB"],
          axes: { PointerX: 1, PointerY: 2 },
        });
        expect(one.world.hash()).toBe(two.world.hash());
        // An axis back at 0 is one nobody moved.
        const still = yield* App.make(App.define({ plugins: [Input.plugin] }));
        still.dispatch(Input.Report, { down: ["KeyA", "KeyB"] });
        one.dispatch(Input.Report, { axes: { PointerX: 0, PointerY: 0 } });
        expect(one.world.hash()).toBe(still.world.hash());
        // What went up is applied before what went down: a key in both
        // was let go and pressed again, and is held.
        const repressed = yield* App.make(
          App.define({ plugins: [Input.plugin] })
        );
        repressed.dispatch(Input.Report, { down: ["KeyA"] });
        repressed.tick(1);
        repressed.dispatch(Input.Report, { down: ["KeyA"], up: ["KeyA"] });
        const held = yield* App.make(App.define({ plugins: [Input.plugin] }));
        held.dispatch(Input.Report, { down: ["KeyA"] });
        held.tick(1);
        expect(repressed.world.hash()).not.toBe(held.world.hash());
        let seen = "";
        const Look = System.make("Look", function* () {
          const keys = yield* Input.Keyboard;
          seen = `${keys.down("KeyA")} ${keys.pressed("KeyA")} ${keys.released("KeyA")}`;
        });
        const looking = yield* App.make(
          App.define({ plugins: [Input.plugin], systems: [Look] })
        );
        looking.dispatch(Input.Report, { down: ["KeyA"] });
        looking.tick(1);
        looking.dispatch(Input.Report, { down: ["KeyA"], up: ["KeyA"] });
        looking.tick(1);
        expect(seen).toBe("true true true");
        // A report that says what is so already is accepted, and writes
        // nothing: a key that is down did not go down again.
        one.tick(1);
        const before = one.world.hash();
        const again = one.dispatch(Input.Report, {
          down: ["KeyA"],
          up: ["KeyZ"],
          axes: { PointerX: 0 },
        });
        expect(Exit.isSuccess(again)).toBe(true);
        expect(one.world.hash()).toBe(before);
        const fresh = yield* App.make(App.define({ plugins: [Input.plugin] }));
        const empty = fresh.world.hash();
        expect(
          Exit.isSuccess(
            fresh.dispatch(Input.Report, {
              up: ["KeyZ"],
              axes: { PointerX: 0 },
            })
          )
        ).toBe(true);
        expect(Exit.isSuccess(fresh.dispatch(Input.Report, {}))).toBe(true);
        expect(fresh.world.hash()).toBe(empty);
      })
    );
  });

  it("forgets a button that went up once the tick it went up in is over", () => {
    run(
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ plugins: [Input.plugin] }));
        const never = yield* App.make(App.define({ plugins: [Input.plugin] }));
        app.dispatch(Input.Report, { down: ["KeyA", "KeyB"] });
        never.dispatch(Input.Report, { down: ["KeyB"] });
        app.tick(1);
        never.tick(1);
        app.dispatch(Input.Report, { up: ["KeyA"] });
        app.tick(1);
        never.tick(1);
        // Still remembered: it went up in the tick that just ran.
        expect(app.world.hash()).not.toBe(never.world.hash());
        // The next report, of anything, drops it: even one that says it
        // went up, which it did long ago.
        const late = app.dispatch(Input.Report, {
          up: ["KeyA"],
          axes: { PointerX: 4 },
        });
        expect(Exit.isSuccess(late)).toBe(true);
        never.dispatch(Input.Report, { axes: { PointerX: 4 } });
        expect(app.world.hash()).toBe(never.world.hash());
      })
    );
  });

  it("is left as it is where there are no devices: reports from elsewhere drive a game through a driver", () => {
    // A game played from a keyboard, through a driver, and its reports.
    const source = Input.makeManualSource();
    const { hashes, log } = run(
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ plugins: [Flying] }), {
          checkpointEvery: 0,
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
          step(0.1);
          seen.push(app.world.hash());
        }
        return { hashes: seen, log: app.actionLog as Action.Logged[] };
      }).pipe(withSource(source))
    );
    // The same game with no devices, given those reports as they came,
    // and run by the same driver, which runs its input stage too: as a
    // peer on another machine is, or a recording played back at speed.
    run(
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ plugins: [Flying] }), {
          checkpointEvery: 0,
        });
        const step = Driver.fixedStep(app, { hz: 10 });
        for (let tick = 0; tick < hashes.length; tick++) {
          for (const entry of log.filter((one) => one.tick === tick)) {
            app.enqueueByName(entry.name, entry.payload);
          }
          step(0.1);
          expect(app.world.hash(), `tick ${tick + 1}`).toBe(hashes[tick]);
        }
        // Nothing was reported of devices that are not there.
        expect(reports(app)).toEqual(log.map((entry) => entry.payload));
        // And a key said to be held stays held, however often it is read.
        app.dispatch(Input.Report, { down: ["ArrowLeft"] });
        const before = ship(app).x;
        step(0.1);
        app.input();
        app.input();
        step(0.1);
        expect(ship(app).x).toBeCloseTo(before - 2, 5);
        expect(reports(app).length).toBe(log.length + 1);
      })
    );
  });

  it("is what the devices say: a report made by hand lasts until they are next read", () => {
    const source = Input.makeManualSource();
    run(
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ plugins: [Flying] }), {
          checkpointEvery: 0,
        });
        const step = (): void => {
          app.input();
          app.tick(1);
        };
        // The key has a history: down, and up again.
        source.press("ArrowRight");
        step();
        source.release("ArrowRight");
        step();
        expect(ship(app).x).toBe(10);
        // A tool says it is down. No device does. A tick that reads no
        // device takes the tool's word.
        app.dispatch(Input.Report, { down: ["ArrowRight"] });
        app.tick(1, { input: false });
        expect(ship(app).x).toBe(20);
        // One that reads them, as a tick does unless told, is told the
        // key is up before it runs.
        app.dispatch(Input.Report, { down: ["ArrowRight"] });
        app.tick(1);
        expect(ship(app).x).toBe(20);
        expect(reports(app).at(-1)).toEqual({ up: ["ArrowRight"] });
        app.dispatch(Input.Report, { down: ["ArrowRight"] });
        app.tick(1, { input: false });
        expect(ship(app).x).toBe(30);
        step();
        expect(reports(app).at(-1)).toEqual({ up: ["ArrowRight"] });
        expect(ship(app).x).toBe(30);
      }).pipe(withSource(source))
    );
  });

  it("refuses a report that is not one, as any action's payload is checked", () => {
    run(
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ plugins: [Input.plugin] }));
        const before = app.world.hash();
        for (const payload of [
          { down: "KeyA" },
          { axes: { PointerX: "left" } },
          { axes: { PointerX: null } },
          { up: [1] },
        ]) {
          const exit = app.dispatchByName("arcadekit/Input.Report", payload);
          expect(Exit.isFailure(exit), JSON.stringify(payload)).toBe(true);
          expect(
            Cause.squash((exit as Exit.Failure<unknown, unknown>).cause)
          ).toBeInstanceOf(Action.InvalidPayload);
        }
        const exit = app.dispatch(Input.Report, {
          axes: { PointerX: Number.POSITIVE_INFINITY },
        });
        expect(Exit.isFailure(exit)).toBe(true);
        expect(app.world.hash()).toBe(before);
      })
    );
  });

  it("is saved with a game, and brought up to date by the devices when it is loaded", () => {
    const source = Input.makeManualSource();
    const save = run(
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ plugins: [Flying] }));
        source.press("ArrowRight");
        source.move(Input.pointerX, 50);
        app.input();
        app.tick(1);
        expect(ship(app).x).toBe(10);
        const taken = app.save();
        assert(Exit.isSuccess(taken));
        return taken.value;
      }).pipe(withSource(source))
    );
    // Loaded with no devices and never asked to read any: the key is held.
    run(
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ plugins: [Flying] }), {
          save,
        });
        app.tick(1);
        app.tick(1);
        expect(ship(app).x).toBe(30);
      })
    );
    // Loaded where the key is no longer down: the first read lets it go.
    const later = Input.makeManualSource();
    later.move(Input.pointerX, 50);
    run(
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ plugins: [Flying] }), {
          save,
        });
        app.input();
        app.tick(1);
        expect(ship(app).x).toBe(10);
        expect(reports(app)).toEqual([{ up: ["ArrowRight"] }]);
        app.input();
        app.tick(1);
        expect(reports(app).length).toBe(1);
      }).pipe(withSource(later))
    );
    // Loaded where there is no pointer either: its place goes back to 0.
    run(
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ plugins: [Flying] }), {
          save,
        });
        app.input();
        expect(reports(app)).toEqual([
          { up: ["ArrowRight"], axes: { PointerX: 0 } },
        ]);
      }).pipe(withSource(Input.makeManualSource()))
    );
  });

  it("says in a handler what its tick's systems will be told: the tick an action is applied in is the one to come", () => {
    const seen: string[] = [];
    const Probe = Action.define("in/Probe", Schema.Struct({}));
    const probe = Action.handler(Probe, function* () {
      const keys = yield* Input.Keyboard;
      seen.push(
        `handler ${(yield* Time).tick + 1}:${keys.down("Space") ? " down" : ""}${keys.pressed("Space") ? " pressed" : ""}${keys.released("Space") ? " released" : ""}`
      );
    });
    const Look = System.make("Look", function* () {
      const keys = yield* Input.Keyboard;
      seen.push(
        `system ${(yield* Time).tick}:${keys.down("Space") ? " down" : ""}${keys.pressed("Space") ? " pressed" : ""}${keys.released("Space") ? " released" : ""}`
      );
    });
    // The key is bound to the action, so both arrive in the same tick: the
    // report first, since the plugin's system runs before the binding.
    const Controls = Input.bind(
      "in/ProbeKeys",
      Input.onPress("Space", Probe, {}),
      Input.onRelease("Space", Probe, {})
    );
    const source = Input.makeManualSource();
    run(
      Effect.gen(function* () {
        const app = yield* App.make(
          App.define({
            plugins: [Input.plugin],
            handlers: [probe],
            systems: [Controls, Look],
          })
        );
        const step = (): void => {
          app.input();
          app.tick(1);
        };
        source.press("Space");
        step();
        // Held, and an action that comes a tick later: the press is past.
        app.enqueue(Probe, {});
        step();
        source.release("Space");
        step();
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
        app.dispatch(Input.Report, { down: ["Space"] });
        app.dispatch(Probe, {});
        // A tick that reads no device, so that the report stands.
        app.tick(1, { input: false });
        app.dispatch(Probe, {});
        expect(seen).toEqual([
          "handler 4: down pressed",
          "system 4: down pressed",
          "handler 5: down",
        ]);
      }).pipe(withSource(source))
    );
  });

  it("is each world's own", () => {
    const left = Input.makeManualSource();
    const right = Input.makeManualSource();
    run(
      Effect.gen(function* () {
        const one = yield* App.make(App.define({ plugins: [Flying] })).pipe(
          withSource(left)
        );
        const two = yield* App.make(App.define({ plugins: [Flying] })).pipe(
          withSource(right)
        );
        left.press("ArrowLeft");
        right.press("ArrowRight");
        for (const app of [one, two]) {
          app.input();
          app.tick(1);
          app.tick(1);
        }
        expect(ship(one).x).toBe(-20);
        expect(ship(two).x).toBe(20);
      })
    );
  });

  it("is read by a handler and by what draws the game, as by a system", () => {
    class NotHeld extends Data.TaggedError("NotHeld")<{}> {}
    const Shoot = Action.define("in/Shoot", Schema.Struct({}));
    const shoot = Action.handler(Shoot, function* () {
      if (!(yield* Input.Keyboard).down("Space")) {
        return yield* new NotHeld();
      }
      (yield* Score).points += 1;
    });
    const source = Input.makeManualSource();
    run(
      Effect.gen(function* () {
        const drawn: string[] = [];
        const Draw = System.make("Draw", function* () {
          const pointer = yield* Input.Pointer;
          drawn.push(`${pointer.x},${pointer.y} ${pointer.down()}`);
        }).pipe(System.inStage("frame"));
        const app = yield* App.make(
          App.define({
            plugins: [Input.plugin],
            handlers: [shoot],
            systems: [Draw],
          })
        );
        expect(Exit.isFailure(app.dispatch(Shoot, {}))).toBe(true);
        source.press("Space");
        source.move(Input.pointerX, 3);
        source.press(Input.pointerButton());
        app.input();
        app.tick(1);
        const before = app.world.hash();
        app.frame(0);
        expect(drawn).toEqual(["3,0 true"]);
        expect(app.world.hash()).toBe(before);
        expect(Exit.isSuccess(app.dispatch(Shoot, {}))).toBe(true);
        expect(app.world.singleton(Score).points).toBe(1);
        // A refused action leaves the picture as it was.
        source.release("Space");
        app.input();
        app.tick(1);
        const held = app.world.hash();
        expect(Exit.isFailure(app.dispatch(Shoot, {}))).toBe(true);
        expect(app.world.hash()).toBe(held);
      }).pipe(withSource(source))
    );
  });
});

describe("bindings", () => {
  const Jump = Action.define("in/Jump");
  const Land = Action.define("in/Land", Schema.Struct({}));
  const Fire = Action.define(
    "in/Fire",
    Schema.Struct({ x: Schema.Finite, y: Schema.Finite })
  );
  const Aim = Action.define("in/Aim", Schema.Struct({ x: Schema.Finite }));
  const done: string[] = [];
  const handlers = [
    Action.handler(Jump, function* () {
      done.push(`jump at ${(yield* Time).tick}`);
    }),
    Action.handler(Land, function* () {
      done.push("land");
    }),
    Action.handler(Fire, function* ({ x, y }) {
      done.push(`fire ${x},${y}`);
    }),
    Action.handler(Aim, function* ({ x }) {
      done.push(`aim ${x}`);
    }),
  ] as const;
  const Controls = Input.bind(
    "in/Controls",
    Input.onPress(["Space", Input.padButton(0, 0)], Jump),
    Input.onRelease("Space", Land, {}),
    Input.onPress(Input.pointerButton(), Fire, (devices) => ({
      x: devices.axes.get(Input.pointerX) ?? 0,
      y: devices.axes.get(Input.pointerY) ?? 0,
    })),
    Input.onMove([Input.pointerX, Input.padAxis(0, 0)], Aim, (devices) => ({
      x: devices.axes.get(Input.pointerX) ?? 0,
    }))
  );
  const Game = Plugin.make("Game", { handlers, systems: [Controls] });

  it("throw for a payload the action's schema refuses, which no other peer could hear of", () => {
    const Step = Action.define("in/Step", Schema.Struct({ by: Schema.Int }));
    const Walk = Input.bind(
      "in/Walk",
      Input.onMove(Input.pointerX, Step, (devices) => ({
        by: devices.axes.get(Input.pointerX) ?? 0,
      }))
    );
    const source = Input.makeManualSource();
    run(
      Effect.gen(function* () {
        const app = yield* App.make(
          App.define({
            handlers: [Action.handler(Step, function* () {})],
            systems: [Walk],
          })
        );
        source.move(Input.pointerX, 2);
        app.input();
        source.move(Input.pointerX, 2.5);
        expect(() => app.input()).toThrow(
          'A system of the frame or input stage issued the action "in/Step" with a payload its schema does not take: Expected an integer'
        );
      }).pipe(withSource(source))
    );
  });

  it("issue the game's own actions when their moment comes, once each, in the order they were given", () => {
    const source = Input.makeManualSource();
    run(
      Effect.gen(function* () {
        done.length = 0;
        const app = yield* App.make(App.define({ plugins: [Game] }), {
          checkpointEvery: 0,
        });
        expect(app.inputOrder).toEqual(["in/Controls"]);
        const step = (): void => {
          app.input();
          app.tick(1);
        };
        step();
        expect(done).toEqual([]);
        // Two of its codes at once is one press.
        source.press("Space");
        source.press(Input.padButton(0, 0));
        step();
        expect(done).toEqual(["jump at 1"]);
        // Held: nothing more.
        step();
        expect(done.length).toBe(1);
        source.release("Space");
        source.move(Input.pointerX, 40);
        source.move(Input.pointerY, 30);
        source.press(Input.pointerButton());
        step();
        expect(done.slice(1)).toEqual(["land", "fire 40,30", "aim 40"]);
        // An axis nobody is bound to moves nothing, and a button of the
        // pointer that is not the main one fires nothing.
        source.move(Input.pointerY, 31);
        source.press(Input.pointerButton(1));
        source.release(Input.padButton(0, 0));
        step();
        expect(done.length).toBe(4);
        // A tap is a press and a release.
        source.tap("Space");
        step();
        expect(done.slice(4)).toEqual(["jump at 5", "land"]);
        expect(
          app.actionLog.map((entry) =>
            Action.isCheckpoint(entry) ? "?" : entry.name
          )
        ).toEqual([
          "in/Jump",
          "in/Land",
          "in/Fire",
          "in/Aim",
          "in/Jump",
          "in/Land",
        ]);
      }).pipe(withSource(source))
    );
  });

  it("are in the log as those actions, so a replay has them and reads no device", () => {
    const source = Input.makeManualSource();
    const recording = run(
      Effect.gen(function* () {
        done.length = 0;
        const app = yield* App.make(App.define({ plugins: [Game] }), {
          checkpointEvery: 1,
        });
        source.press("Space");
        source.move(Input.pointerX, 7);
        app.input();
        app.tick(1);
        source.tap(Input.pointerButton());
        app.input();
        app.tick(1);
        return app.record();
      }).pipe(withSource(source))
    );
    const { log } = recording;
    const played = [...done];
    expect(played).toEqual(["jump at 0", "aim 7", "fire 7,0"]);
    expect(log.filter((entry) => !Action.isCheckpoint(entry))).toEqual([
      { tick: 0, name: "in/Jump", payload: null, queued: true },
      { tick: 0, name: "in/Aim", payload: { x: 7 }, queued: true },
      { tick: 1, name: "in/Fire", payload: { x: 7, y: 0 }, queued: true },
    ]);
    run(
      Effect.gen(function* () {
        done.length = 0;
        // The same handlers, and nothing that listens to a device.
        const again = yield* Journal.replay(recording, (start) =>
          App.make(App.define({ handlers }), {
            ...start,
            checkpointEvery: 1,
          })
        );
        expect(again.inputOrder).toEqual([]);
        expect(done).toEqual(played);
      })
    );
  });

  it("say so when the action they are bound to has no handler", () => {
    const source = Input.makeManualSource();
    run(
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ systems: [Controls] }));
        app.input();
        source.press("Space");
        expect(() => app.input()).toThrow(/No handler for action "in\/Jump"/);
      }).pipe(withSource(source))
    );
  });

  it("take a payload that the compiler checks against the action", () => {
    expectTypeOf(
      Input.onPress("KeyF", Fire, { x: 1, y: 2 })
    ).toEqualTypeOf<Input.Binding>();
    expectTypeOf(Input.onPress("KeyJ", Jump)).toEqualTypeOf<Input.Binding>();
    Input.onPress(
      "KeyF",
      Fire,
      // @ts-expect-error a payload that is not the action's
      { x: 1 }
    );
    // @ts-expect-error an action with a payload needs one
    Input.onPress("KeyF", Fire);
    Input.onMove(
      Input.pointerX,
      Aim,
      // @ts-expect-error a function that gives something else
      () => ({ y: 1 })
    );
  });
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
