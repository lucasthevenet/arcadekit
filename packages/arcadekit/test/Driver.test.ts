import { Cause, Data, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  App,
  Component,
  Driver,
  Field,
  Frame,
  Plugin,
  Query,
  Script,
  System,
  Time,
} from "../src/index";

const Ball = Component.define("dr/Ball", { x: Field.f32, vx: Field.f32 });
const Balls = Query.all(Ball);

const Roll = System.make("Roll", function* () {
  const { delta } = yield* Time;
  (yield* Balls).each((ball) => {
    ball.x += ball.vx * delta;
  });
});

/** A frame every 1/60 s, starting at `from` milliseconds. */
const turn = (
  display: Driver.ManualDisplay,
  frames: number,
  from: number
): number => {
  let now = from;

  for (let i = 0; i < frames; i += 1) {
    display.frame(now);
    now += 1000 / 60;
  }

  return now;
};

const withDisplay =
  (display: Driver.DisplayShape) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, Driver.Display, display);

/** An app and a frame loop over it, both in the scope the caller closes. */
const started = Effect.fnUntraced(function* (
  display: Driver.ManualDisplay,
  hz = 60
) {
  const drawn: number[] = [];

  const Draw = System.make("Draw", function* () {
    drawn.push((yield* Frame).alpha);
  }).pipe(System.inStage("frame"));

  const app = yield* App.make({ systems: [Roll, Draw] });

  const fiber = yield* Effect.forkScoped(
    Driver.frames(app, { hz }).pipe(withDisplay(display)),
    { startImmediately: true }
  );

  return { app, drawn, fiber };
});

describe("the frame loop", () => {
  it("asks the display for a frame, and for the next after each", async () => {
    const display = Driver.makeManualDisplay();
    const scope = Effect.runSync(Scope.make());

    const { app, drawn } = await Effect.runPromise(
      Scope.provide(started(display), scope)
    );

    expect(display.pending).toBe(1);
    expect(display.watching).toBe(1);
    expect(display.frame(1000)).toBe(1);
    expect(display.pending).toBe(1);
    // The first frame draws the game as it stands and runs no tick.
    expect(app.time.tick).toBe(0);
    expect(drawn).toStrictEqual([0]);
    turn(display, 6, 1000 + 1000 / 60);
    expect(app.time.tick).toBe(6);
    expect(drawn).toHaveLength(7);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("ticks at its own rate whatever the rate of frames, and tells the frame stage how far between two ticks it is", async () => {
    const display = Driver.makeManualDisplay();
    const scope = Effect.runSync(Scope.make());

    // Ticks of 100 ms against frames of 40 ms.
    const { app, drawn } = await Effect.runPromise(
      Scope.provide(started(display, 10), scope)
    );

    app.world.spawn(Ball.of({ x: 0, vx: 10 }));
    const ticks: number[] = [];

    for (const now of [500, 540, 580, 620, 660, 700, 1030]) {
      display.frame(now);
      ticks.push(app.time.tick);
    }

    expect(ticks).toStrictEqual([0, 0, 0, 1, 1, 2, 5]);
    expect(drawn.map((alpha) => Math.round(alpha * 100) / 100)).toStrictEqual([
      0, 0.4, 0.8, 0.2, 0.6, 0, 0.3,
    ]);
    // Each tick was a tenth of a second of the game, exactly.
    expect(app.time.elapsed).toBeCloseTo(0.5, 9);
    expect(app.world.view(Balls).entities()).toHaveLength(1);
    let x = 0;
    app.world.view(Balls).each((ball) => {
      ({ x } = ball);
    });
    expect(x).toBeCloseTo(5, 5);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("gives the frame stage the real seconds since the frame before", async () => {
    const display = Driver.makeManualDisplay();
    const deltas: number[] = [];

    const Draw = System.make("Draw", function* () {
      deltas.push((yield* Frame).delta);
    }).pipe(System.inStage("frame"));

    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* App.make({ systems: [Draw] });

          return yield* Driver.frames(app, { hz: 60 });
        })
      ).pipe(withDisplay(display))
    );

    display.frame(100);
    display.frame(125);
    display.frame(175);
    // A clock that went backwards is no time at all, not negative time.
    display.frame(170);
    expect(deltas.map((delta) => Math.round(delta * 1000))).toStrictEqual([
      0, 25, 50, 0,
    ]);
    await Effect.runPromise(Fiber.interrupt(fiber));
  });

  it("asks for no frame while the tab is hidden, and the time spent hidden does not count", async () => {
    const display = Driver.makeManualDisplay();
    const scope = Effect.runSync(Scope.make());

    const { app, drawn } = await Effect.runPromise(
      Scope.provide(started(display), scope)
    );

    const now = turn(display, 4, 0);
    expect(app.time.tick).toBe(3);
    display.hide();
    expect(display.pending).toBe(0);
    expect(display.watching).toBe(1);
    // Nothing is asked for, so nothing runs.
    expect(display.frame(now + 5000)).toBe(0);
    expect(app.time.tick).toBe(3);
    const frames = drawn.length;
    // Ten minutes later.
    display.show();
    expect(display.pending).toBe(1);
    const later = now + 600_000;
    display.frame(later);
    // The first frame back draws, and time is counted from it.
    expect(app.time.tick).toBe(3);
    expect(drawn).toHaveLength(frames + 1);
    turn(display, 3, later + 1000 / 60);
    expect(app.time.tick).toBe(6);
    // Hidden and shown twice over asks for one frame, not two.
    display.hide();
    display.show();
    display.hide();
    display.show();
    expect(display.pending).toBe(1);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("does not run a frame that comes due after the tab was hidden", async () => {
    // A display that goes on calling back while it says it is hidden: the
    // page was hidden between the request and the frame.
    const inner = Driver.makeManualDisplay();
    let hidden = false;

    const display: Driver.ManualDisplay = {
      ...inner,
      get pending() {
        return inner.pending;
      },
      get watching() {
        return inner.watching;
      },
      hidden: () => hidden,
    };

    const scope = Effect.runSync(Scope.make());

    const { app, drawn } = await Effect.runPromise(
      Scope.provide(started(display), scope)
    );

    turn(inner, 3, 0);
    expect(app.time.tick).toBe(2);
    hidden = true;
    expect(inner.frame(10_000)).toBe(1);
    expect(app.time.tick).toBe(2);
    expect(drawn).toHaveLength(3);
    expect(inner.pending).toBe(0);
    // Shown again: whoever watches the tab is told, and the loop goes on
    // from there, the ten seconds forgotten.
    hidden = false;
    inner.hide();
    inner.show();
    expect(inner.pending).toBe(1);
    turn(inner, 3, 20_000);
    expect(app.time.tick).toBe(4);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("waits for the tab to be shown when it starts hidden", async () => {
    const display = Driver.makeManualDisplay();
    display.hide();
    const scope = Effect.runSync(Scope.make());

    const { app } = await Effect.runPromise(
      Scope.provide(started(display), scope)
    );

    expect(display.pending).toBe(0);
    expect(display.watching).toBe(1);
    display.show();
    expect(display.pending).toBe(1);
    turn(display, 3, 0);
    expect(app.time.tick).toBe(2);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("leaves nothing behind when it is interrupted", async () => {
    const display = Driver.makeManualDisplay();
    let app: App.Any | undefined;

    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          app = yield* App.make({ systems: [Roll] });

          return yield* Driver.frames(app, { hz: 60 });
        })
      ).pipe(withDisplay(display))
    );

    turn(display, 5, 0);
    expect(app!.time.tick).toBe(4);
    expect(display.pending).toBe(1);
    expect(display.watching).toBe(1);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(display.pending).toBe(0);
    expect(display.watching).toBe(0);
    expect(display.frame(1000)).toBe(0);
    // Nor does the tab coming back start it again.
    display.hide();
    display.show();
    expect(display.pending).toBe(0);
    expect(app!.time.tick).toBe(4);
  });

  it("does nothing when a frame it had asked for arrives after it was stopped", async () => {
    // A display that cannot take a request back, as a late callback would
    // be, and that goes on telling a listener it was asked to forget.
    const callbacks: ((now: number) => void)[] = [];
    let listening = 0;
    let tell = (): void => {};
    let hidden = false;

    const display: Driver.DisplayShape = {
      request(callback) {
        callbacks.push(callback);

        return () => {};
      },
      hidden: () => hidden,
      onVisibilityChange(listener) {
        listening += 1;
        tell = listener;

        return () => {
          listening -= 1;
        };
      },
    };

    let app: App.Any | undefined;

    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          app = yield* App.make({ systems: [Roll] });

          return yield* Driver.frames(app, { hz: 60 });
        })
      ).pipe(withDisplay(display))
    );

    callbacks.shift()!(0);
    callbacks.shift()!(20);
    expect(app!.time.tick).toBe(1);
    expect(callbacks).toHaveLength(1);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(listening).toBe(0);
    callbacks.shift()!(40);
    expect(app!.time.tick).toBe(1);
    expect(callbacks).toHaveLength(0);
    // Nor does the tab coming back ask for a frame.
    hidden = true;
    tell();
    hidden = false;
    tell();
    expect(callbacks).toHaveLength(0);
  });

  it("stops with the app's scope: closing it leaves nothing running", async () => {
    const display = Driver.makeManualDisplay();
    const log: string[] = [];

    const Engine = Plugin.make("Engine", {
      layer: Layer.effectDiscard(
        Effect.acquireRelease(
          Effect.sync(() => log.push("sound opened")),
          () => Effect.sync(() => log.push("sound closed"))
        )
      ),
      systems: [Roll],
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

    const scope = Effect.runSync(Scope.make());

    const { app, fiber } = await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const made = yield* App.make({ plugins: [Engine] });

          const loop = yield* Effect.forkScoped(
            Driver.frames(made, { hz: 60 }).pipe(withDisplay(display)),
            { startImmediately: true }
          );

          return { app: made, fiber: loop };
        }),
        scope
      )
    );

    turn(display, 4, 0);
    expect(app.time.tick).toBe(3);
    expect(log).toStrictEqual(["sound opened"]);
    expect(fiber.pollUnsafe()).toBeUndefined();

    await Effect.runPromise(Scope.close(scope, Exit.void));

    // The loop is over, with no frame asked for and the tab not watched.
    const exit = fiber.pollUnsafe();
    expect(exit !== undefined && Exit.isFailure(exit)).toBe(true);
    expect(
      Cause.hasInterruptsOnly((exit as Exit.Failure<never, never>).cause)
    ).toBe(true);
    expect(display.pending).toBe(0);
    expect(display.watching).toBe(0);
    // The script was stopped and what the plugin held was let go.
    expect(log.toSorted()).toStrictEqual([
      "script stopped",
      "sound closed",
      "sound opened",
    ]);
    // And no frame runs a tick any more.
    expect(display.frame(5000)).toBe(0);
    expect(app.time.tick).toBe(3);
  });

  it("stops and dies with what a tick throws, leaving nothing behind", async () => {
    class Jammed extends Data.TaggedError("Jammed")<{ readonly at: number }> {}

    const Jam = System.make("Jam", function* () {
      const { tick } = yield* Time;

      if (tick === 3) {
        return yield* Effect.fail(new Jammed({ at: tick }));
      }
    });

    const display = Driver.makeManualDisplay();

    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* App.make({ systems: [Jam] });

          return yield* Driver.frames(app, { hz: 60 });
        })
      ).pipe(withDisplay(display))
    );

    turn(display, 3, 0);
    expect(fiber.pollUnsafe()).toBeUndefined();
    turn(display, 1, 3000 / 60);
    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(
      Cause.squash((exit as Exit.Failure<never, never>).cause)
    ).toStrictEqual(new Jammed({ at: 3 }));
    expect(display.pending).toBe(0);
    expect(display.watching).toBe(0);
  });

  it("stops and dies with what the frame stage throws", async () => {
    const Smear = System.make("Smear", function* () {
      if ((yield* Frame).count === 2) {
        throw new Error("the canvas is gone");
      }
    }).pipe(System.inStage("frame"));

    const display = Driver.makeManualDisplay();

    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* App.make({ systems: [Smear] });

          return yield* Driver.frames(app, { hz: 60 });
        })
      ).pipe(withDisplay(display))
    );

    turn(display, 2, 0);
    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(
      (Cause.squash((exit as Exit.Failure<never, never>).cause) as Error)
        .message
    ).toBe("the canvas is gone");
    expect(display.pending).toBe(0);
    expect(display.watching).toBe(0);
  });

  it("drops the backlog of a long stall, as fixedStep does", async () => {
    const display = Driver.makeManualDisplay();
    let app: App.Any | undefined;

    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          app = yield* App.make({ systems: [Roll] });

          return yield* Driver.frames(app, { hz: 60, maxStepsPerCall: 3 });
        })
      ).pipe(withDisplay(display))
    );

    display.frame(0);
    // The page froze for two seconds without being hidden.
    display.frame(2000);
    expect(app!.time.tick).toBe(3);
    display.frame(2000 + 1000 / 60);
    expect(app!.time.tick).toBe(4);
    await Effect.runPromise(Fiber.interrupt(fiber));
  });
});

describe("the display when none is provided", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a timer, and stops with the loop", async () => {
    // The frames it asks for are the timers of a sixtieth of a second.
    const asked: unknown[] = [];
    const cleared = new Set<unknown>();
    const { clearTimeout: clear, setTimeout: set } = globalThis;
    vi.stubGlobal("setTimeout", (run: () => void, ms?: number) => {
      const id = set(run, ms);

      if (ms === 1000 / 60) {
        asked.push(id);
      }

      return id;
    });
    vi.stubGlobal("clearTimeout", (id: unknown) => {
      cleared.add(id);
      clear(id as ReturnType<typeof set>);
    });
    let app: App.Any | undefined;

    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          app = yield* App.make({ systems: [Roll] });

          return yield* Driver.frames(app, { hz: 200 });
        })
      )
    );

    await new Promise((resolve) => setTimeout(resolve, 120));
    await Effect.runPromise(Fiber.interrupt(fiber));
    const ticks = app!.time.tick;
    // About 24 ticks in 120 ms at 200 Hz; a busy machine runs fewer, or
    // takes longer over it.
    expect(ticks).toBeGreaterThan(3);
    // The frame that was asked for and not yet due was taken back, and no
    // other was.
    expect(asked.length).toBeGreaterThan(3);
    expect(asked.filter((id) => cleared.has(id))).toStrictEqual([asked.at(-1)]);
    await new Promise((resolve) => set(resolve, 60));
    expect(app!.time.tick).toBe(ticks);
  });
});

/** Something to step that says when it is settled, and notes what it was asked. */
const makeStepped = () => {
  const stepped = {
    settled: true,
    calls: [] as string[],
    ticks: 0,
    /** Run by the input stage: where a move comes in. */
    onInput: (): void => {},
    /** Run by a tick: what it leaves waiting, if anything. */
    onTick: (): void => {},
    input() {
      stepped.calls.push("input");
      stepped.onInput();
    },
    tick(delta: number) {
      stepped.calls.push(`tick ${delta}`);
      stepped.ticks += 1;
      stepped.onTick();
    },
    frame(alpha: number) {
      // To two decimals: what is left of a tick is a sum of floats.
      stepped.calls.push(`frame ${Math.round(alpha * 100) / 100}`);
    },
  };

  return stepped;
};

describe("ticking when needed", () => {
  it("rests while nothing is waiting: the input stage and the frame stage run, and no tick", () => {
    const game = makeStepped();
    const advance = Driver.fixedStep(game, { hz: 10, ticks: "whenNeeded" });
    // Until a tick's worth of time has passed nothing is due, as ever.
    expect(advance(0)).toBe(0);
    expect(advance(0.04)).toBe(0);
    expect(game.calls).toStrictEqual(["frame 0", "frame 0.4"]);
    game.calls.length = 0;

    // From then on: every frame the devices are read, and the game is
    // drawn all the way to its last tick.
    for (let frame = 0; frame < 50; frame += 1) {
      expect(advance(0.016)).toBe(0);
    }

    expect(game.ticks).toBe(0);
    expect(game.calls.slice(0, 2)).toStrictEqual(["frame 0.56", "frame 0.72"]);
    expect(game.calls.slice(-4)).toStrictEqual([
      "input",
      "frame 1",
      "input",
      "frame 1",
    ]);
    expect(game.calls.filter((call) => call === "input")).toHaveLength(47);
  });

  it("ticks in the frame a move arrives in, while anything is waiting, and once more after", () => {
    const game = makeStepped();
    const advance = Driver.fixedStep(game, { hz: 10, ticks: "whenNeeded" });
    advance(1);
    advance(1);
    expect(game.ticks).toBe(0);
    game.calls.length = 0;
    // A move comes in with the devices, and is done with after two ticks.
    let waiting = 0;
    let arriving = true;
    game.onInput = () => {
      if (arriving) {
        arriving = false;
        waiting = 2;
        game.settled = false;
      }
    };

    game.onTick = () => {
      waiting -= 1;
      game.settled = waiting <= 0;
    };

    // However little time has passed: the time spent at rest was kept.
    expect(advance(0.001)).toBe(1);
    expect(game.calls).toStrictEqual(["input", "tick 0.1", "frame 0"]);
    // Then at the game's own rate, as any game: no tick until one is due.
    expect(advance(0.05)).toBe(0);
    expect(advance(0.05)).toBe(1);
    expect(game.settled).toBe(true);
    // Settled, and once more: for what reacts a tick late.
    expect(advance(0.1)).toBe(1);
    expect(game.ticks).toBe(3);
    // And then it rests.
    game.calls.length = 0;
    expect(advance(0.1)).toBe(0);
    expect(advance(0.1)).toBe(0);
    expect(game.calls).toStrictEqual(["input", "frame 1", "input", "frame 1"]);
    expect(game.ticks).toBe(3);
    // A frame long enough for the last tick and for finding the game at
    // rest after it: drawn all the way to that tick, in that same frame.
    arriving = true;
    advance(0.05);
    game.calls.length = 0;
    expect(advance(0.3)).toBe(2);
    expect(game.calls).toStrictEqual([
      "input",
      "tick 0.1",
      "input",
      "tick 0.1",
      "input",
      "frame 1",
    ]);
  });

  it("owes no ticks for the time it rested, and drops a backlog as ever while it does not rest", () => {
    const game = makeStepped();

    const advance = Driver.fixedStep(game, {
      hz: 10,
      ticks: "whenNeeded",
      maxStepsPerCall: 3,
    });

    // A long rest.
    for (let i = 0; i < 20; i += 1) {
      advance(5);
    }

    expect(game.ticks).toBe(0);
    // Something that is never done: it ticks at its rate from here on,
    // one tick for the frame the move came in, not one per second rested.
    game.settled = false;
    expect(advance(0.016)).toBe(1);
    expect(advance(0.016)).toBe(0);
    expect(advance(0.1)).toBe(1);
    // A stall while it is busy: three ticks, and the rest dropped.
    expect(advance(60)).toBe(3);
    expect(advance(0.05)).toBe(0);
    expect(advance(0.05)).toBe(1);
  });

  it("is how the frame loop runs a game at rest: a frame asked for and drawn each time, the tab watched, and no tick", async () => {
    const display = Driver.makeManualDisplay();
    const alphas: number[] = [];

    const Draw = System.make("Draw", function* () {
      alphas.push((yield* Frame).alpha);
    }).pipe(System.inStage("frame"));

    const scope = Effect.runSync(Scope.make());

    const app = Effect.runSync(
      App.make({ systems: [Roll, Draw] }).pipe(Scope.provide(scope))
    );

    app.world.spawn(Ball.of({ x: 0, vx: 60 }));

    const fiber = Effect.runFork(
      Driver.frames(app, { hz: 60, ticks: "whenNeeded" }).pipe(
        withDisplay(display)
      )
    );

    let now = turn(display, 120, 0);
    // Two seconds of frames. A game that has just been made runs a tick,
    // in which it could have asked for more, and the one that follows the
    // last; then nothing asks, and the ball rolls no further.
    expect(app.time.tick).toBe(2);
    expect(alphas).toHaveLength(120);
    expect(alphas.at(-1)).toBe(1);
    expect(display.pending).toBe(1);
    expect(display.watching).toBe(1);
    // A script that waits out a tenth of a second of the game's time:
    // six ticks, and one more.
    app.spawnScript(Effect.flatMap(Script, (script) => script.sleep(0.1)));
    now = turn(display, 60, now);
    expect(app.time.tick).toBe(9);
    // Hidden, it asks for nothing; shown, it is at rest as it was.
    display.hide();
    expect(display.pending).toBe(0);
    display.show();
    now = turn(display, 30, now + 5000);
    expect(app.time.tick).toBe(9);
    expect(display.pending).toBe(1);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(display.pending).toBe(0);
    expect(display.watching).toBe(0);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("is asked for: left out, a settled game ticks all the same, and so does one that does not say", () => {
    const game = makeStepped();
    const always = Driver.fixedStep(game, { hz: 10 });
    expect(always(0.35)).toBe(3);
    const told = makeStepped();
    expect(Driver.fixedStep(told, { hz: 10, ticks: "always" })(0.35)).toBe(3);
    // Something with a tick and nothing to say of itself needs every one.
    let ticks = 0;

    const plain = Driver.fixedStep(
      {
        tick: () => {
          ticks += 1;
        },
      },
      { hz: 10, ticks: "whenNeeded" }
    );

    plain(0.35);
    plain(0.1);
    expect(ticks).toBe(4);
  });
});
