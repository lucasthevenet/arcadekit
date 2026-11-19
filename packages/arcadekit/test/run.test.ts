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
import { describe, expect, it } from "vitest";

import * as Browser from "../src/Browser";
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
  Script,
  Singleton,
  System,
  Time,
} from "../src/index";

const Ball = Component.define("run/Ball", { x: Field.f32, vx: Field.f32 });
const Balls = Query.all(Ball);

const Score = Singleton.define(
  "run/Score",
  { points: Field.i32 },
  { points: 0 }
);

const Add = Action.define("run/Add", Schema.Struct({ by: Schema.Int }));

const add = Action.handler(Add, function* ({ by }) {
  (yield* Score).points += by;
});

/** A frame every 1/60 s, starting at `from` milliseconds. */
const turn = (
  display: Driver.ManualDisplay,
  frames: number,
  from = 0
): void => {
  for (let i = 0; i < frames; i += 1) {
    display.frame(from + (i * 1000) / 60);
  }
};

/** A game that says what it holds on to, and when it lets go. */
const makeGame = () => {
  const log: string[] = [];

  const Roll = System.make("Roll", function* () {
    const { delta } = yield* Time;
    (yield* Balls).each((ball) => {
      ball.x += ball.vx * delta;
    });
  });

  const Draw = System.make("Draw", function* () {
    if ((yield* Frame).count === 1) {
      log.push("first frame");
    }
  }).pipe(System.inStage("frame"));

  const Game = Plugin.make("Game", {
    components: [Ball, Score],
    handlers: [add],
    systems: [Roll, Draw],
    layer: Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.sync(() => log.push("sound opened")),
        () => Effect.sync(() => log.push("sound closed"))
      )
    ),
    setup: Effect.map(Commands, (commands) => {
      log.push("setup");
      commands.spawn(Ball.of({ x: 0, vx: 60 }));
    }),
    scripts: [
      Effect.gen(function* () {
        const script = yield* Script;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => log.push("script stopped"))
        );

        for (;;) {
          yield* script.nextTick;
        }
      }).pipe(Effect.scoped),
    ],
  });

  return { Game, log };
};

const position = (app: App.Any): number => {
  let x = Number.NaN;
  app.world.view(Balls).each((ball) => {
    ({ x } = ball);
  });

  return x;
};

describe("App.run", () => {
  it("makes the app, follows the display, and leaves nothing running when it is interrupted", async () => {
    const { Game, log } = makeGame();
    const display = Driver.makeManualDisplay();
    let made: App.Any | undefined;

    const fiber = Effect.runFork(
      App.run(
        { plugins: [Game] },
        {
          hz: 60,
          ready: (app) =>
            Effect.sync(() => {
              log.push(`ready, ${display.pending} frames asked for`);
              made = app;
            }),
        }
      ).pipe(Effect.provideService(Driver.Display, display))
    );

    // Made, with its setup run, and told to its caller before any frame
    // is asked for.
    expect(log).toStrictEqual([
      "sound opened",
      "setup",
      "ready, 0 frames asked for",
    ]);
    expect(display.pending).toBe(1);
    expect(display.watching).toBe(1);
    turn(display, 4);
    expect(made!.time.tick).toBe(3);
    expect(position(made!)).toBeCloseTo(3, 4);
    expect(log.at(-1)).toBe("first frame");
    // It does not end by itself.
    expect(fiber.pollUnsafe()).toBeUndefined();

    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(display.pending).toBe(0);
    expect(display.watching).toBe(0);
    expect(log.slice(4).toSorted()).toStrictEqual([
      "script stopped",
      "sound closed",
    ]);
    expect(display.frame(1000)).toBe(0);
    expect(made!.time.tick).toBe(3);
  });

  it("gives ready the app with its handlers, and lets go of what ready acquired", async () => {
    const { Game, log } = makeGame();
    const display = Driver.makeManualDisplay();

    class Menu extends Context.Service<
      Menu,
      { readonly onStart: (press: () => void) => void }
    >()("run/Menu") {}

    let press = (): void => {};

    const fiber = Effect.runFork(
      App.run(
        { plugins: [Game] },
        {
          hz: 60,
          ready: (app) =>
            Effect.gen(function* () {
              const menu = yield* Menu;
              // Typed from the game's handlers.
              menu.onStart(() => app.dispatch(Add, { by: 5 }));
              // @ts-expect-error not a payload of the action
              void (() => app.dispatch(Add, { by: "five" }));
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => log.push("menu unwired"))
              );
              log.push(`score ${app.world.singleton(Score).points}`);
            }),
        }
      ).pipe(
        Effect.provideService(Driver.Display, display),
        // What ready needs is needed of whoever runs the game.
        Effect.provideService(Menu, {
          onStart: (given) => {
            press = given;
          },
        })
      )
    );

    expect(log.at(-1)).toBe("score 0");
    press();
    turn(display, 2);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(log).toContain("menu unwired");

    // Not providing it does not compile.
    const unprovided = App.run(
      { plugins: [Game] },
      { hz: 60, ready: () => Effect.asVoid(Effect.service(Menu)) }
    );

    // @ts-expect-error Menu is still required
    void (() => Effect.runFork(unprovided));
    // A game that needs nothing from outside runs as it is.
    void (() => Effect.runFork(App.run({ plugins: [Game] }, { hz: 60 })));
  });

  it("fails with what ready fails with, and with what making the app fails with, holding on to nothing", async () => {
    class NoCanvas extends Data.TaggedError("NoCanvas")<{}> {}

    class NoSound extends Data.TaggedError("NoSound")<{}> {}

    const { Game, log } = makeGame();
    const display = Driver.makeManualDisplay();

    const failed = await Effect.runPromise(
      Effect.exit(
        App.run(
          { plugins: [Game] },
          { hz: 60, ready: () => Effect.fail(new NoCanvas()) }
        )
      ).pipe(Effect.provideService(Driver.Display, display))
    );

    expect(Exit.isFailure(failed)).toBe(true);
    expect(
      Cause.squash((failed as Exit.Failure<never, NoCanvas>).cause)
    ).toStrictEqual(new NoCanvas());
    expect(log.slice(0, 2)).toStrictEqual(["sound opened", "setup"]);
    expect(log.slice(2).toSorted()).toStrictEqual([
      "script stopped",
      "sound closed",
    ]);
    expect(display.pending).toBe(0);
    expect(display.watching).toBe(0);

    const Silent = Plugin.make("Silent", {
      layer: Layer.effectDiscard(Effect.fail(new NoSound())),
    });

    let ready = false;

    const exit = await Effect.runPromise(
      Effect.exit(
        App.run(
          { plugins: [Silent] },
          {
            hz: 60,
            ready: () =>
              Effect.sync(() => {
                ready = true;
              }),
          }
        )
      ).pipe(Effect.provideService(Driver.Display, display))
    );

    // Typed: what the plugins and ready can fail with, and nothing else.
    const typed: Exit.Exit<never, NoSound> = exit;
    expect(
      Cause.squash((typed as Exit.Failure<never, NoSound>).cause)
    ).toStrictEqual(new NoSound());
    expect(ready).toBe(false);
    expect(display.pending).toBe(0);
  });

  it("goes on from a save when given one, and says why when the save cannot be loaded", async () => {
    const { Game, log } = makeGame();
    const display = Driver.makeManualDisplay();
    let made: App.Any | undefined;

    const keep = (app: App.Any) =>
      Effect.sync(() => {
        made = app;
      });

    const first = Effect.runFork(
      App.run({ plugins: [Game] }, { hz: 60, ready: keep }).pipe(
        Effect.provideService(Driver.Display, display)
      )
    );

    turn(display, 6);
    const taken = made!.save();
    expect(Exit.isSuccess(taken)).toBe(true);
    const save = (taken as Exit.Success<Save.Save>).value;
    await Effect.runPromise(Fiber.interrupt(first));
    expect(save.tick).toBe(5);

    log.length = 0;

    const second = Effect.runFork(
      App.run({ plugins: [Game] }, { hz: 60, save, ready: keep }).pipe(
        Effect.provideService(Driver.Display, display)
      )
    );

    // No setup: the save holds what it spawned.
    expect(log).toStrictEqual(["sound opened"]);
    expect(made!.time.tick).toBe(5);
    expect(position(made!)).toBeCloseTo(5, 4);
    turn(display, 3, 5000);
    expect(made!.time.tick).toBe(7);
    expect(position(made!)).toBeCloseTo(7, 4);
    await Effect.runPromise(Fiber.interrupt(second));

    // A save of a game that this is not.
    const exit = await Effect.runPromise(
      Effect.exit(
        App.run(
          { systems: [] },
          { hz: 60, save: { ...save, world: new Uint8Array([1, 2, 3]) } }
        )
      ).pipe(Effect.provideService(Driver.Display, display))
    );

    const typed: Exit.Exit<never, Save.LoadRefused> = exit;
    expect(Exit.isFailure(typed)).toBe(true);
    expect(
      Cause.squash((typed as Exit.Failure<never, Save.LoadRefused>).cause)
    ).toBeInstanceOf(Save.LoadRefused);
    expect(display.pending).toBe(0);

    // Without a save, loading is not among what can go wrong.
    const fresh: Effect.Effect<never, never> = App.run(
      { systems: [] },
      { hz: 60 }
    );

    void fresh;
  });

  it("dies with what a tick throws, and lets go of everything", async () => {
    class Jammed extends Data.TaggedError("Jammed")<{}> {}

    const { Game, log } = makeGame();

    const Jam = System.make("Jam", function* () {
      if ((yield* Time).tick === 2) {
        return yield* Effect.fail(new Jammed());
      }
    });

    const display = Driver.makeManualDisplay();

    const fiber = Effect.runFork(
      App.run({ plugins: [Game], systems: [Jam] }, { hz: 60 }).pipe(
        Effect.provideService(Driver.Display, display)
      )
    );

    turn(display, 3);
    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(
      Cause.squash((exit as Exit.Failure<never, never>).cause)
    ).toStrictEqual(new Jammed());
    expect(display.pending).toBe(0);
    expect(display.watching).toBe(0);
    expect(log).toContain("sound closed");
    expect(log).toContain("script stopped");
  });

  it("runs a game that moves when its player does: drawn every frame, and ticked only while something waits", async () => {
    const display = Driver.makeManualDisplay();
    let frames = 0;

    const Count = System.make("run/Count", function* () {
      frames += 1;
    }).pipe(System.inStage("frame"));

    let made: App.Any | undefined;
    let ask = (_by: number): void => {};

    const fiber = Effect.runFork(
      App.run(
        { handlers: [add], components: [Score], systems: [Count] },
        {
          hz: 60,
          ticks: "whenNeeded",
          ready: (app) =>
            Effect.sync(() => {
              made = app;
              ask = (by) => app.enqueue(Add, { by });
            }),
        }
      ).pipe(Effect.provideService(Driver.Display, display))
    );

    let now = 0;

    const repaint = (count: number): void => {
      for (let i = 0; i < count; i += 1) {
        display.frame(now);
        now += 1000 / 60;
      }
    };

    repaint(90);
    expect(frames).toBe(90);
    // The tick a new game runs to be asked in, and the one after it.
    expect(made!.time.tick).toBe(2);
    // A move: the tick that applies it, and one more.
    ask(4);
    repaint(1);
    expect(made!.time.tick).toBe(3);
    expect(made!.world.singleton(Score).points).toBe(4);
    repaint(60);
    expect(made!.time.tick).toBe(4);
    expect(frames).toBe(151);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(display.pending).toBe(0);
  });

  it("passes on how a long stall is handled", async () => {
    const { Game } = makeGame();
    const display = Driver.makeManualDisplay();
    let made: App.Any | undefined;

    const fiber = Effect.runFork(
      App.run(
        { plugins: [Game] },
        {
          hz: 60,
          maxStepsPerCall: 2,
          ready: (app) =>
            Effect.sync(() => {
              made = app;
            }),
        }
      ).pipe(Effect.provideService(Driver.Display, display))
    );

    display.frame(0);
    display.frame(3000);
    expect(made!.time.tick).toBe(2);
    await Effect.runPromise(Fiber.interrupt(fiber));
  });

  it("keeps what is provided to it for as long as it runs, as a page's devices need", async () => {
    // A page that counts who is listening to it.
    class Page extends EventTarget {
      listening = 0;

      override addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null
      ): void {
        this.listening += 1;
        super.addEventListener(type, listener);
      }

      override removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null
      ): void {
        this.listening -= 1;
        super.removeEventListener(type, listener);
      }
    }

    const page = new Page();
    const display = Driver.makeManualDisplay();
    const seen: boolean[] = [];

    const Watch = System.make("Watch", function* () {
      seen.push((yield* Input.Keyboard).down("KeyA"));
    });

    const fiber = Effect.runFork(
      App.run({ plugins: [Input.plugin], systems: [Watch] }, { hz: 60 }).pipe(
        // The page's devices, and a display turned by hand in place of the
        // page's: what is provided nearer the game is the one it gets.
        Effect.provideService(Driver.Display, display),
        Effect.provide(
          Browser.layer({ window: page, gamepads: () => [], sounds: false })
        )
      )
    );

    expect(page.listening).toBe(7);
    turn(display, 2);
    page.dispatchEvent(
      Object.assign(new Event("keydown"), { code: "KeyA", repeat: false })
    );
    turn(display, 2, 2000 / 60);
    expect(seen).toStrictEqual([false, true, true]);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(page.listening).toBe(0);
  });

  it("runs where there is no page, on a timer", async () => {
    const { Game, log } = makeGame();
    let made: App.Any | undefined;

    const fiber = Effect.runFork(
      App.run(
        { plugins: [Game] },
        {
          hz: 200,
          ready: (app) =>
            Effect.sync(() => {
              made = app;
            }),
        }
      )
    );

    await new Promise((resolve) => setTimeout(resolve, 120));
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(made!.time.tick).toBeGreaterThan(3);
    expect(log).toContain("sound closed");
    const ticks = made!.time.tick;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(made!.time.tick).toBe(ticks);
  });
});
