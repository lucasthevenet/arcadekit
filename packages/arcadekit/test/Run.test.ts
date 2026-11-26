import { assert, describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Data,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schema,
} from "effect";

import * as Browser from "../src/browser/Browser.ts";
import {
  Action,
  App,
  Commands,
  Component,
  Driver,
  Field,
  Frame,
  Input,
  Plugin,
  Query,
  Save,
  Singleton,
  System,
  Time,
} from "../src/index.ts";

const Ball = Component.define("run/Ball", { x: Field.f32, vx: Field.f32 });
const Balls = Query.all(Ball).pipe(Query.writes(Ball));
const Rolling = Query.all(Ball);
const Score = Singleton.define(
  "run/Score",
  { points: Field.i32 },
  { points: 0 }
);
const Add = Action.define("run/Add", Schema.Struct({ by: Schema.Int }));
const add = Action.handler(Add, function* ({ by }) {
  (yield* Score.writes).points += by;
});

/** A frame every 1/60 s, starting at `from` milliseconds. */
const turn = (
  display: Driver.ManualDisplay,
  frames: number,
  from = 0
): void => {
  for (let i = 0; i < frames; i++) {
    display.frame(from + (i * 1000) / 60);
  }
};

/** A game that says what it holds on to, and when it lets go. */
const makeGame = () => {
  const log: string[] = [];
  const Roll = System.tick("Roll", function* () {
    const { delta } = yield* Time;
    (yield* Balls).each((ball) => {
      ball.x += ball.vx * delta;
    });
  });
  const Draw = System.frame("Draw", function* () {
    if ((yield* Frame).count === 1) {
      log.push("first frame");
    }
  });
  const Game = Plugin.make("Game", {
    handlers: [add],
    systems: [Roll, Draw],
    layer: Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.sync(() => log.push("sound opened")),
        () => Effect.sync(() => log.push("sound closed"))
      )
    ),
    setup: Effect.map(Commands.spawns(Ball), (commands) => {
      log.push("setup");
      commands.spawn(Ball.of({ x: 0, vx: 60 }));
    }),
  });
  return { Game, log };
};

const position = Effect.fnUntraced(function* (app: App.Any) {
  let x = Number.NaN;
  (yield* app.read(Rolling)).each((ball) => {
    ({ x } = ball);
  });
  return x;
});

describe("Driver.run", () => {
  it.effect(
    "makes the app, follows the display, and leaves nothing running when it is interrupted",
    () =>
      Effect.gen(function* () {
        const { Game, log } = makeGame();
        const display = Driver.makeManualDisplay();
        let made: App.Any | undefined;
        const fiber = yield* Effect.forkChild(
          Driver.run(App.define({ plugins: [Game] }), {
            hz: 60,
            ready: (app) =>
              Effect.sync(() => {
                log.push(`ready, ${display.pending} frames asked for`);
                made = app;
              }),
          }).pipe(Effect.provideService(Driver.Display, display)),
          { startImmediately: true }
        );
        // Made, with its setup run, and told to its caller before any frame
        // is asked for.
        expect(log).toEqual([
          "sound opened",
          "setup",
          "ready, 0 frames asked for",
        ]);
        expect(display.pending).toBe(1);
        expect(display.watching).toBe(1);
        turn(display, 4);
        expect(made!.time.tick).toBe(3);
        expect(yield* position(made!)).toBeCloseTo(3, 4);
        expect(log.at(-1)).toBe("first frame");
        // It does not end by itself.
        expect(fiber.pollUnsafe()).toBeUndefined();

        yield* Fiber.interrupt(fiber);
        expect(display.pending).toBe(0);
        expect(display.watching).toBe(0);
        expect(log.slice(4)).toEqual(["sound closed"]);
        expect(display.frame(1000)).toBe(0);
        expect(made!.time.tick).toBe(3);
      })
  );

  it.effect(
    "lets a step before the first frame have the app with its handlers, and lets go of what it acquired",
    () =>
      Effect.gen(function* () {
        const { Game, log } = makeGame();
        const display = Driver.makeManualDisplay();
        class Menu extends Context.Service<
          Menu,
          {
            readonly onStart: (press: Effect.Effect<unknown>) => void;
          }
        >()("run/Menu") {}
        let press: Effect.Effect<unknown> = Effect.void;
        const fiber = yield* Effect.forkChild(
          Driver.run(App.define({ plugins: [Game] }), {
            hz: 60,
            ready: (app) =>
              Effect.gen(function* () {
                const menu = yield* Menu;
                // Typed from the game's handlers.
                menu.onStart(Effect.orDie(app.dispatch(Add, { by: 5 })));
                // @ts-expect-error not a payload of the action
                void app.dispatch(Add, { by: "five" });
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => log.push("menu unwired"))
                );
                log.push(`score ${(yield* app.read(Score)).points}`);
              }),
          }).pipe(
            Effect.provideService(Driver.Display, display),
            // What that step needs is needed of whoever runs the game.
            Effect.provideService(Menu, {
              onStart: (given) => {
                press = given;
              },
            })
          ),
          { startImmediately: true }
        );
        expect(log.at(-1)).toBe("score 0");
        yield* press;
        turn(display, 2);
        yield* Fiber.interrupt(fiber);
        expect(log.includes("menu unwired")).toBe(true);
        // Not providing it does not compile.
        const unprovided = Driver.run(App.define({ plugins: [Game] }), {
          hz: 60,
          ready: () => Effect.asVoid(Effect.service(Menu)),
        });
        expectTypeOf<
          Effect.Services<typeof unprovided>
        >().toEqualTypeOf<Menu>();
        // A game that needs nothing from outside runs as it is.
        const provided = Driver.run(App.define({ plugins: [Game] }), {
          hz: 60,
        });
        expectTypeOf<Effect.Services<typeof provided>>().toEqualTypeOf<never>();
      })
  );

  it.effect(
    "fails with what making the app fails with, a step before the first frame included, holding on to nothing",
    () =>
      Effect.gen(function* () {
        class NoCanvas extends Data.TaggedError("NoCanvas")<{}> {}
        class NoSound extends Data.TaggedError("NoSound")<{}> {}
        const { Game, log } = makeGame();
        const display = Driver.makeManualDisplay();
        const fiber = yield* Effect.forkChild(
          Driver.run(App.define({ plugins: [Game] }), {
            hz: 60,
            ready: () => Effect.fail(new NoCanvas()),
          }).pipe(Effect.provideService(Driver.Display, display)),
          { startImmediately: true }
        );
        const failed: Exit.Exit<never, NoCanvas> | undefined =
          fiber.pollUnsafe();
        assert(failed !== undefined && Exit.isFailure(failed));
        expect(Cause.squash(failed.cause)).toEqual(new NoCanvas());
        expect(log.slice(0, 2)).toEqual(["sound opened", "setup"]);
        expect(log.slice(2)).toEqual(["sound closed"]);
        expect(display.pending).toBe(0);
        expect(display.watching).toBe(0);

        const Silent = Plugin.make("Silent", {
          layer: Layer.effectDiscard(Effect.fail(new NoSound())),
        });
        let reached = false;
        const exit = yield* Effect.exit(
          Driver.run(App.define({ plugins: [Silent] }), {
            hz: 60,
            ready: () =>
              Effect.sync(() => {
                reached = true;
              }),
          })
        ).pipe(Effect.provideService(Driver.Display, display));
        // Typed: what making the app can fail with, and nothing else.
        const typed: Exit.Exit<never, NoSound> = exit;
        expect(
          Cause.squash((typed as Exit.Failure<never, NoSound>).cause)
        ).toEqual(new NoSound());
        expect(reached).toBe(false);
        expect(display.pending).toBe(0);

        // A step tapped onto the making, which would leave the app open when it
        // fails, has nowhere to go.
        void Driver.run(
          // @ts-expect-error it takes the game, and makes the app itself
          App.make(App.define({ plugins: [Game] })).pipe(
            Effect.tap(() => Effect.fail(new NoCanvas()))
          ),
          { hz: 60 }
        );
      })
  );

  it.effect(
    "goes on from a save when given one, and says why when the save cannot be loaded",
    () =>
      Effect.gen(function* () {
        const { Game, log } = makeGame();
        const display = Driver.makeManualDisplay();
        let made: App.Any | undefined;
        const keep = (app: App.Any) =>
          Effect.sync(() => {
            made = app;
          });
        const first = yield* Effect.forkChild(
          Driver.run(App.define({ plugins: [Game] }), {
            hz: 60,
            ready: keep,
          }).pipe(Effect.provideService(Driver.Display, display)),
          { startImmediately: true }
        );
        turn(display, 6);
        const taken = yield* Effect.exit(Save.make(made!));
        assert(Exit.isSuccess(taken));
        const save = taken.value;
        expect(made!.time.tick).toBe(5);
        yield* Fiber.interrupt(first);

        log.length = 0;
        const second = yield* Effect.forkChild(
          Driver.run(App.define({ plugins: [Game] }), {
            save,
            hz: 60,
            ready: keep,
          }).pipe(Effect.provideService(Driver.Display, display)),
          { startImmediately: true }
        );
        // No setup: the save holds what it spawned.
        expect(log).toEqual(["sound opened"]);
        expect(made!.time.tick).toBe(5);
        expect(yield* position(made!)).toBeCloseTo(5, 4);
        turn(display, 3, 5000);
        expect(made!.time.tick).toBe(7);
        expect(yield* position(made!)).toBeCloseTo(7, 4);
        yield* Fiber.interrupt(second);

        // A save of a game that this is not.
        const exit = yield* Effect.exit(
          Driver.run(App.define({ systems: [] }), {
            save: { ...save, world: new Uint8Array([1, 2, 3]) },
            hz: 60,
          })
        ).pipe(Effect.provideService(Driver.Display, display));
        const typed: Exit.Exit<never, Save.LoadRefused> = exit;
        expect(Exit.isFailure(typed)).toBe(true);
        expect(
          Cause.squash((typed as Exit.Failure<never, Save.LoadRefused>).cause)
        ).toBeInstanceOf(Save.LoadRefused);
        expect(display.pending).toBe(0);
        // Without a save, loading is not among what can go wrong.
        const fresh: Effect.Effect<never, never> = Driver.run(
          App.define({ systems: [] }),
          { hz: 60 }
        );
        void fresh;
      })
  );

  it.effect(
    "fails with what a tick fails with, which a program catches by its tag, and lets go of everything",
    () =>
      Effect.gen(function* () {
        class Jammed extends Data.TaggedError("Jammed")<{}> {}
        const { Game, log } = makeGame();
        const Jam = System.tick("Jam", function* () {
          if ((yield* Time).tick === 2) {
            return yield* new Jammed();
          }
        });
        const display = Driver.makeManualDisplay();
        const fiber = yield* Effect.forkChild(
          Driver.run(App.define({ plugins: [Game], systems: [Jam] }), {
            hz: 60,
          }).pipe(
            Effect.provideService(Driver.Display, display),
            Effect.catchTag("Jammed", (jammed) => Effect.succeed(jammed))
          ),
          { startImmediately: true }
        );
        turn(display, 3);
        expect(yield* Fiber.await(fiber)).toEqual(Exit.succeed(new Jammed()));
        expect(display.pending).toBe(0);
        expect(display.watching).toBe(0);
        expect(log.includes("sound closed")).toBe(true);
      })
  );

  it.effect(
    "runs a game that moves when its player does: drawn every frame, and ticked only while something waits",
    () =>
      Effect.gen(function* () {
        const display = Driver.makeManualDisplay();
        let frames = 0;
        const Count = System.frame("run/Count", function* () {
          frames++;
        });
        let made: App.Any | undefined;
        let ask = (_by: number): Effect.Effect<void> => Effect.void;
        const fiber = yield* Effect.forkChild(
          Driver.run(App.define({ handlers: [add], systems: [Count] }), {
            hz: 60,
            ticks: "whenNeeded",
            ready: (app) =>
              Effect.sync(() => {
                made = app;
                ask = (by) => Effect.orDie(app.enqueue(Add, { by }));
              }),
          }).pipe(Effect.provideService(Driver.Display, display)),
          { startImmediately: true }
        );
        let now = 0;
        const repaint = (count: number): void => {
          for (let i = 0; i < count; i++) {
            display.frame(now);
            now += 1000 / 60;
          }
        };
        repaint(90);
        expect(frames).toBe(90);
        // The tick a new game runs, which changes nothing but its time.
        expect(made!.time.tick).toBe(1);
        // A move: the tick that applies it, and the one that finds nothing
        // more to change.
        yield* ask(4);
        repaint(1);
        expect(made!.time.tick).toBe(2);
        expect((yield* made!.read(Score)).points).toBe(4);
        repaint(60);
        expect(made!.time.tick).toBe(3);
        expect(frames).toBe(151);
        yield* Fiber.interrupt(fiber);
        expect(display.pending).toBe(0);
      })
  );

  it.effect("passes on how a long stall is handled", () =>
    Effect.gen(function* () {
      const { Game } = makeGame();
      const display = Driver.makeManualDisplay();
      let made: App.Any | undefined;
      const fiber = yield* Effect.forkChild(
        Driver.run(App.define({ plugins: [Game] }), {
          hz: 60,
          maxStepsPerCall: 2,
          ready: (app) =>
            Effect.sync(() => {
              made = app;
            }),
        }).pipe(Effect.provideService(Driver.Display, display)),
        { startImmediately: true }
      );
      display.frame(0);
      display.frame(3000);
      expect(made!.time.tick).toBe(2);
      yield* Fiber.interrupt(fiber);
    })
  );

  it.effect(
    "keeps what is provided to it for as long as it runs, as a page's devices need",
    () =>
      Effect.gen(function* () {
        // A page that counts who is listening to it.
        class Page extends EventTarget {
          listening = 0;

          override addEventListener(
            type: string,
            listener: EventListenerOrEventListenerObject | null
          ): void {
            this.listening++;
            super.addEventListener(type, listener);
          }

          override removeEventListener(
            type: string,
            listener: EventListenerOrEventListenerObject | null
          ): void {
            this.listening--;
            super.removeEventListener(type, listener);
          }
        }
        const page = new Page();
        const display = Driver.makeManualDisplay();
        const seen: boolean[] = [];
        const Watch = System.tick("Watch", function* () {
          seen.push((yield* Input.Keyboard).down("KeyA"));
        });
        const fiber = yield* Effect.forkChild(
          Driver.run(
            App.define({ plugins: [Input.plugin], systems: [Watch] }),
            {
              hz: 60,
            }
          ).pipe(
            // The page's devices, and a display turned by hand in place of the
            // page's: what is provided nearer the game is the one it gets.
            Effect.provideService(Driver.Display, display),
            Effect.provide(
              Browser.layer({ window: page, gamepads: () => [], sounds: false })
            )
          ),
          { startImmediately: true }
        );
        expect(page.listening).toBe(7);
        turn(display, 2);
        page.dispatchEvent(
          Object.assign(new Event("keydown"), { code: "KeyA", repeat: false })
        );
        turn(display, 2, 2000 / 60);
        expect(seen).toEqual([false, true, true]);
        yield* Fiber.interrupt(fiber);
        expect(page.listening).toBe(0);
      })
  );

  it.effect("runs where there is no page, on a timer", () =>
    Effect.gen(function* () {
      const { Game, log } = makeGame();
      let made: App.Any | undefined;
      const fiber = yield* Effect.forkChild(
        Driver.run(App.define({ plugins: [Game] }), {
          hz: 200,
          ready: (app) =>
            Effect.sync(() => {
              made = app;
            }),
        }),
        { startImmediately: true }
      );
      yield* Effect.promise(
        () => new Promise((resolve) => setTimeout(resolve, 120))
      );
      yield* Fiber.interrupt(fiber);
      expect(made!.time.tick).toBeGreaterThan(3);
      expect(log.includes("sound closed")).toBe(true);
      const ticks = made!.time.tick;
      yield* Effect.promise(
        () => new Promise((resolve) => setTimeout(resolve, 50))
      );
      expect(made!.time.tick).toBe(ticks);
    })
  );
});
