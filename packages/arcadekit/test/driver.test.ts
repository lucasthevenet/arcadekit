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
  for (let i = 0; i < frames; i++) {
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
    expect(drawn).toEqual([0]);
    turn(display, 6, 1000 + 1000 / 60);
    expect(app.time.tick).toBe(6);
    expect(drawn.length).toBe(7);
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
    expect(ticks).toEqual([0, 0, 0, 1, 1, 2, 5]);
    expect(drawn.map((alpha) => Math.round(alpha * 100) / 100)).toEqual([
      0, 0.4, 0.8, 0.2, 0.6, 0, 0.3,
    ]);
    // Each tick was a tenth of a second of the game, exactly.
    expect(app.time.elapsed).toBeCloseTo(0.5, 9);
    expect(app.world.view(Balls).entities().length).toBe(1);
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
    expect(deltas.map((delta) => Math.round(delta * 1000))).toEqual([
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
    expect(drawn.length).toBe(frames + 1);
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
    expect(drawn.length).toBe(3);
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
        listening++;
        tell = listener;
        return () => {
          listening--;
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
    expect(callbacks.length).toBe(1);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(listening).toBe(0);
    callbacks.shift()!(40);
    expect(app!.time.tick).toBe(1);
    expect(callbacks.length).toBe(0);
    // Nor does the tab coming back ask for a frame.
    hidden = true;
    tell();
    hidden = false;
    tell();
    expect(callbacks.length).toBe(0);
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
    expect(log).toEqual(["sound opened"]);
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
    expect(log.toSorted()).toEqual([
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
    expect(Cause.squash((exit as Exit.Failure<never, never>).cause)).toEqual(
      new Jammed({ at: 3 })
    );
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
    expect(asked.filter((id) => cleared.has(id))).toEqual([asked.at(-1)]);
    await new Promise((resolve) => set(resolve, 60));
    expect(app!.time.tick).toBe(ticks);
  });
});
