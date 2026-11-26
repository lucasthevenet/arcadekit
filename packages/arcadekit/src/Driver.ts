/**
 * A driver decides when an app ticks. An app advances only through
 * `tick(delta)`, so the same game runs in real time, turn by turn, or as fast
 * as possible in a test.
 *
 *   Driver.run(Duel, { hz: 60 })                     // the usual entry point
 *   const step = Driver.fixedStep(app, { hz: 60 })   // by hand: yield* step(seconds)
 *   yield* Driver.frames(app, { hz: 60 })            // in a page, once per repaint
 *   yield* Driver.interval(app, { hz: 60 })          // on a timer
 *
 * A session ticks by the `delta` all its peers are made with, so its driver
 * takes no `hz`: `Driver.frames(session)`.
 *
 * What a driver steps returns an Effect from each step, and the driver
 * yields it: one Effect a tick, and one a frame. It fails with what a tick
 * or a frame fails with.
 */
import { Clock, Context, Duration, Effect, Schedule } from "effect";
import type { Scope } from "effect";

import * as App from "./App.ts";
import type * as Plugin from "./Plugin.ts";
import type * as Save from "./Save.ts";

/**
 * Anything with a `tick` that takes the length of the tick in seconds. A
 * driver takes a `Tickable`, so it works with every kind of app.
 *
 * @typeParam E what a tick, the input stage or the frame stage fails with
 *
 * @category Models
 */
export interface Tickable<E = never> {
  readonly tick: (delta: number) => Effect.Effect<void, E>;
  /**
   * An app's input stage, which a driver runs just before each tick when
   * present. A tick reads no device, so the game reads them here.
   */
  readonly input?: () => Effect.Effect<void, E>;
  /**
   * An app's frame stage, which a driver runs after each call's ticks when
   * present.
   */
  readonly frame?: (alpha: number, delta?: number) => Effect.Effect<void, E>;
  /**
   * Whether nothing is waiting for a tick, as `app.settled` reports it. A
   * driver reads it only with `ticks: "whenNeeded"`, and ticks a tickable
   * without it on every tick.
   */
  readonly settled?: boolean;
  /** Absent. Something that ticks by a `delta` of its own is `Paced`. */
  readonly delta?: never;
}

/**
 * Anything that ticks by a `delta` of its own: a session, or a session
 * connected to a transport. A driver runs it at `1 / delta` ticks a second,
 * and takes neither `hz` nor `ticks` for it.
 *
 * @typeParam E what its tick or its frame stage fails with
 *
 * @category Models
 */
export interface Paced<E = never> {
  /** The seconds each of its ticks simulates. */
  readonly delta: number;
  /**
   * Runs its input stage, then its next tick if that tick can run. What it
   * succeeds with is the session's: whether the tick ran.
   */
  readonly tick: () => Effect.Effect<unknown, E>;
  /** Its frame stage, which a driver runs after each call's ticks. */
  readonly frame: (alpha: number, delta?: number) => Effect.Effect<void, E>;
}

/** What a tick of a `Paced` fails with. */
type FailureOf<T> = T extends Paced<infer E> ? E : never;

/**
 * Options for how a driver steps an app.
 *
 * @category Options
 */
export interface StepOptions {
  /** The ticks per second the game runs at, whatever the frame rate. */
  readonly hz: number;
  /**
   * The most ticks one call runs, after a stall. Defaults to 5. The ticks
   * still owed after that are dropped, so a page that froze doesn't run a
   * burst of ticks to catch up.
   */
  readonly maxStepsPerCall?: number;
  /**
   * When the game ticks. `"always"`, the default, ticks at `hz` in real time.
   * `"whenNeeded"` ticks at `hz` only while `app.settled` is false, for a
   * game that moves only when its player does, and rests in between.
   *
   * At rest, no tick runs and game time stands still. The input stage still
   * runs every frame, so a key press, a UI button or a message is handled in
   * the frame it arrives in. The frame stage draws the game at its last tick,
   * with a `Frame.alpha` of 1. Telling whether a tick changed the game costs
   * a hash of the world each tick, about 10 µs for a thousand entities.
   */
  readonly ticks?: "always" | "whenNeeded";
}

/**
 * Options for how a driver steps a session, which ticks at its own `delta`
 * and never rests.
 *
 * @category Options
 */
export interface PacedOptions {
  /**
   * The most ticks one call runs, after a stall, as in `StepOptions`.
   * Defaults to 5.
   */
  readonly maxStepsPerCall?: number;
  /** Absent. Its type is the compiler's error for a driver given one. */
  readonly hz?: "A session ticks 1 / delta times a second, the same on every peer: give its driver no hz.";
  /** Absent. Its type is the compiler's error for a driver given one. */
  readonly ticks?: "A session ticks continuously, since the other peers wait for its messages: give its driver no ticks.";
}

/** How a driver steps what it is given: how long a tick is, and whether it rests. */
interface Pace<E> {
  readonly app: Tickable<E>;
  readonly dt: number;
  readonly maxSteps: number;
  readonly whenNeeded: boolean;
}

/** Returns how a driver steps an app at `hz`, or a session at its own `delta`. */
const paceOf = <E>(
  target: Tickable<E> | Paced<E>,
  options: StepOptions | PacedOptions | undefined
): Pace<E> => {
  const maxSteps = options?.maxStepsPerCall ?? 5;
  if (target.delta !== undefined) {
    // A session reads its devices in its own tick.
    return {
      app: { tick: () => Effect.asVoid(target.tick()), frame: target.frame },
      dt: target.delta,
      maxSteps,
      whenNeeded: false,
    };
  }
  // The signatures give an app the options with `hz`.
  const { hz, ticks } = options as StepOptions;
  return {
    app: target,
    dt: 1 / hz,
    maxSteps,
    whenNeeded: ticks === "whenNeeded",
  };
};

const EPSILON = 1e-9;

/** Returns what `fixedStep` returns for a pace. */
const stepper = <E>({
  app,
  dt,
  maxSteps,
  whenNeeded,
}: Pace<E>): ((realDelta: number) => Effect.Effect<number, E>) => {
  let accumulator = 0;
  // Whether the call before this one found the game at rest.
  let resting = false;
  return Effect.fnUntraced(function* (realDelta: number) {
    // The time spent at rest is not owed. A game at rest has one tick
    // ready, so that the tick a move asks for runs in the frame the move
    // arrives in, and no more than that one.
    accumulator = resting ? dt : accumulator + realDelta;
    resting = false;
    let steps = 0;
    // The epsilon stops float error from swallowing a tick: 1 - 59 * (1 / 60)
    // is a hair less than 1 / 60.
    while (accumulator + EPSILON >= dt && steps < maxSteps) {
      if (app.input !== undefined) {
        yield* app.input();
      }
      if (whenNeeded) {
        // Asked after the input stage, which is where a move comes in.
        if (app.settled === true) {
          resting = true;
          break;
        }
      }
      yield* app.tick(dt);
      accumulator = Math.max(0, accumulator - dt);
      steps++;
    }
    if (resting) {
      // All the way to its last tick: that is where the game stands.
      accumulator = dt;
    } else if (steps === maxSteps && accumulator >= dt) {
      // After a long stall, drop the backlog instead of spiralling.
      accumulator = 0;
    }
    // What is left is part of a tick: how far the frame is into the next.
    if (app.frame !== undefined) {
      yield* app.frame(Math.min(1, accumulator / dt), realDelta);
    }
    return steps;
  });
};

/**
 * Returns a function that steps an app on a fixed timestep. Run what it
 * returns once per frame with the real seconds elapsed. Each step runs zero
 * or more ticks of exactly `1 / hz`, each after the app's input stage. Then
 * it runs the app's frame stage, and succeeds with the number of ticks it
 * ran. It fails with what a tick or a stage fails with.
 *
 *   const step = Driver.fixedStep(app, { hz: 60 })
 *   const ticks = yield* step(1 / 30)   // 2
 *
 * The input stage reads the devices once per tick, so each tick sees one
 * consistent state of them. A frame with no tick due reads nothing, and its
 * input waits for the next tick.
 *
 * The game ticks at a fixed rate whatever the frame rate. The frame stage
 * receives `Frame.alpha`, how far its frame is between the last tick and the
 * next, to interpolate what moves.
 *
 * With `ticks: "whenNeeded"`, it ticks only while the app isn't settled, and
 * rests in between, as `StepOptions` says.
 *
 * A session steps the same way, with ticks of its own `delta`, and takes
 * neither `hz` nor `ticks`: `Driver.fixedStep(session)`.
 *
 * @category Running
 */
export function fixedStep<E>(
  app: Tickable<E>,
  options: StepOptions
): (realDelta: number) => Effect.Effect<number, E>;
export function fixedStep<E>(
  session: Paced<E>,
  options?: PacedOptions
): (realDelta: number) => Effect.Effect<number, E>;
export function fixedStep<E>(
  target: Tickable<E> | Paced<E>,
  options?: StepOptions | PacedOptions
): (realDelta: number) => Effect.Effect<number, E> {
  return stepper(paceOf(target, options));
}

/** Returns what `interval` returns for a pace. */
const beat = <E>(pace: Pace<E>): Effect.Effect<never, E> =>
  Effect.gen(function* () {
    const advance = stepper(pace);
    const period = Duration.millis(pace.dt * 1000);
    let last = yield* Clock.currentTimeNanos;
    const step = Effect.flatMap(Clock.currentTimeNanos, (now) => {
      const since = Number(now - last) / 1e9;
      last = now;
      return advance(since);
    });
    // The first beat a period from now, as a timer's.
    yield* Effect.schedule(step, Schedule.fixed(period));
    return yield* Effect.never;
  });

/**
 * Steps an app on a timer until interrupted, then stops the timer.
 *
 * Each time the timer fires, it runs one `fixedStep` step: the input stage
 * and the ticks that are due, then the frame stage. If a tick or a frame
 * fails or dies, the timer stops and the effect fails or dies with it. A
 * session's timer fires once per tick of its own `delta`, and `interval`
 * takes neither `hz` nor `ticks` for it.
 *
 * **When to use**
 *
 * Use when the app steps on Effect's `Clock`, which a test advances with
 * `TestClock`. In a page, use `frames`, which follows the display.
 *
 * @category Running
 */
export function interval<E>(
  app: Tickable<E>,
  options: StepOptions
): Effect.Effect<never, E>;
export function interval<E>(
  session: Paced<E>,
  options?: PacedOptions
): Effect.Effect<never, E>;
export function interval<E>(
  target: Tickable<E> | Paced<E>,
  options?: StepOptions | PacedOptions
): Effect.Effect<never, E> {
  return beat(paceOf(target, options));
}

/**
 * What a frame loop needs from the screen it draws to: a callback when the next
 * frame is due, and whether anyone can see it.
 *
 * @category Services
 */
export interface DisplayShape {
  /**
   * Requests a single callback when the next frame is due, with the time in
   * milliseconds. Returns a function that cancels the request.
   */
  readonly request: (callback: (now: number) => void) => () => void;
  /** Whether the game is invisible because its tab is hidden. */
  readonly hidden: () => boolean;
  /**
   * Calls `listener` whenever `hidden` may have changed. Returns a function
   * that stops listening.
   */
  readonly onVisibilityChange: (listener: () => void) => () => void;
}

/**
 * A display for environments without a screen: a 60 frames per second timer,
 * never hidden. It holds no state.
 */
const timerDisplay: DisplayShape = {
  request(callback) {
    const id = setTimeout(() => callback(performance.now()), 1000 / 60);
    return () => clearTimeout(id);
  },
  hidden: () => false,
  onVisibilityChange: () => () => {},
};

/**
 * The screen a frame loop follows. Nothing has to provide it. By default it
 * is a timer at 60 frames per second, the only display under Node, in a
 * worker or on a server. A page provides `Browser.display`, which follows
 * `requestAnimationFrame` and the document's visibility, with
 * `Browser.layer()` or `Browser.runMain`. A test provides one it advances by
 * hand:
 *
 *   const display = Driver.makeManualDisplay()
 *   Driver.frames(app, { hz: 60 }).pipe(Effect.provideService(Driver.Display, display))
 *
 * @category Services
 */
export const Display: Context.Reference<DisplayShape> =
  Context.Reference<DisplayShape>("arcadekit/Display", {
    defaultValue: () => timerDisplay,
  });

/**
 * A display advanced by hand, for tests and tools.
 *
 * @category Testing
 */
export interface ManualDisplay extends DisplayShape {
  /**
   * Says that a frame is due at `now` milliseconds. It calls every pending
   * callback and returns how many it called. A callback requested meanwhile
   * waits for the next frame.
   */
  readonly frame: (now: number) => number;
  /** Hides the tab. `hidden` then returns true, and every listener is called. */
  readonly hide: () => void;
  /** Shows the tab again. */
  readonly show: () => void;
  /** The number of pending frame requests. */
  readonly pending: number;
  /** The number of listeners watching for visibility changes. */
  readonly watching: number;
}

/**
 * Makes a display that does nothing until told to: `frame(now)` runs the
 * requested frame, `hide()` and `show()` simulate the tab being hidden and
 * shown, and `pending` and `watching` show what a frame loop left behind.
 *
 * @category Testing
 */
export const makeManualDisplay = (): ManualDisplay => {
  let requests: ((now: number) => void)[] = [];
  const listeners = new Set<() => void>();
  let hidden = false;
  const setHidden = (value: boolean): void => {
    if (hidden === value) {
      return;
    }
    hidden = value;
    for (const listener of Array.from(listeners)) {
      listener();
    }
  };
  return {
    request(callback) {
      requests.push(callback);
      return () => {
        const at = requests.indexOf(callback);
        if (at !== -1) {
          requests.splice(at, 1);
        }
      };
    },
    hidden: () => hidden,
    onVisibilityChange(listener) {
      // Wrapped, so that the same function given twice is two listeners.
      const own = (): void => listener();
      listeners.add(own);
      return () => {
        listeners.delete(own);
      };
    },
    frame(now) {
      const due = requests;
      requests = [];
      for (const callback of due) {
        callback(now);
      }
      return due.length;
    },
    hide: () => setHidden(true),
    show: () => setHidden(false),
    get pending() {
      return requests.length;
    },
    get watching() {
      return listeners.size;
    },
  };
};

/** Returns what `frames` returns for a pace. */
const loop = Effect.fnUntraced(function* <E>(pace: Pace<E>) {
  const display = yield* Display;
  const advance = stepper(pace);
  // When the frame before this one was, or undefined when time starts
  // over: at the first frame, and after the tab was hidden.
  let last: number | undefined;
  // The frame asked for, to take back, and the loop waiting for it.
  let takeBack: (() => void) | undefined;
  let waiting: ((now: number) => void) | undefined;
  const onFrame = (now: number): void => {
    takeBack = undefined;
    if (display.hidden()) {
      // Paused. Whoever watches the tab asks again when it is shown.
      last = undefined;
      return;
    }
    waiting?.(now);
  };
  const ask = (): void => {
    if (takeBack === undefined && !display.hidden()) {
      takeBack = display.request(onFrame);
    }
  };
  const giveUp = (): void => {
    takeBack?.();
    takeBack = undefined;
  };
  // The time of the next frame the display shows. The loop goes on in the
  // display's callback, so a frame's ticks and drawing run in that frame.
  const next = Effect.callback<number>((resume) => {
    waiting = (now) => {
      waiting = undefined;
      resume(Effect.succeed(now));
    };
    ask();
    return Effect.sync(() => {
      waiting = undefined;
      giveUp();
    });
  });
  const unwatch = display.onVisibilityChange(() => {
    if (display.hidden()) {
      giveUp();
      last = undefined;
    } else if (waiting !== undefined) {
      ask();
    }
  });
  return yield* Effect.ensuring(
    Effect.forever(
      Effect.flatMap(next, (now) => {
        const delta = last === undefined ? 0 : Math.max(0, (now - last) / 1000);
        last = now;
        return advance(delta);
      }),
      // The display paces the loop: the next frame is asked for in this one.
      { disableYield: true }
    ),
    Effect.sync(unwatch)
  );
});

/**
 * Runs the frame loop, which follows the display until interrupted. Each time
 * a frame is due, it runs the ticks due at a fixed `hz`, then the app's frame
 * stage, as `fixedStep` does. In a page, a frame is due once per repaint, with
 * `requestAnimationFrame`.
 *
 *   const app = yield* Effect.acquireRelease(
 *     App.make(App.define({ plugins: [Game] })),
 *     (made) => made.close
 *   )
 *   yield* Driver.frames(app, { hz: 60 })
 *
 * It does not close the app it is given, which belongs to whatever made it.
 * `Driver.run` is the loop that makes its app and closes it.
 *
 * A session runs the ticks due at its own `delta`, and `frames` takes neither
 * `hz` nor `ticks` for it:
 *
 *   yield* Driver.frames(yield* Transport.connect(session))
 *
 * - The first frame draws the game as it is and runs no tick. Time is
 *   measured from it.
 * - While the tab is hidden, the loop requests no frames, and the hidden time
 *   doesn't count. A game that becomes visible again resumes where it was.
 * - Interrupting the fiber that runs it cancels its pending frame request and
 *   stops watching the tab, so nothing is left running.
 * - If a tick or a frame fails or dies, it stops the same way and fails or
 *   dies with it.
 * - With `ticks: "whenNeeded"`, for a game that moves only when its player
 *   does, every frame is drawn but a tick runs only while something is waiting
 *   for one:
 *
 *     yield* Driver.frames(app, { hz: 60, ticks: "whenNeeded" })
 *
 * It reaches the screen through `Display`, which a test can replace.
 *
 * @category Running
 */
export function frames<E>(
  app: Tickable<E>,
  options: StepOptions
): Effect.Effect<never, E>;
export function frames<E>(
  session: Paced<E>,
  options?: PacedOptions
): Effect.Effect<never, E>;
export function frames<E>(
  target: Tickable<E> | Paced<E>,
  options?: StepOptions | PacedOptions
): Effect.Effect<never, E> {
  return loop(paceOf(target, options));
}

/**
 * What `Driver.run` closes when it ends, beside the app it makes: a session,
 * or a session connected to a transport.
 *
 * @category Models
 */
export interface Closes {
  /** Lets go of everything it opened. */
  readonly close: Effect.Effect<void>;
}

/**
 * The step `Driver.run` takes as `ready`.
 *
 * @category Options
 */
export interface ReadyOptions<A, E, R> {
  /**
   * Runs once the app is made, before its first frame, with the app. The run
   * closes the app however it ends, so the app is closed when `ready` fails.
   */
  readonly ready?: (app: A) => Effect.Effect<unknown, E, R>;
}

/** Runs what `made` makes until interrupted, and closes it however it ends. */
const runMade = <
  E3,
  A extends (Tickable<E3> | Paced<E3>) & Closes,
  E,
  R,
  E2,
  R2,
>(
  made: Effect.Effect<A, E, R>,
  options: ((StepOptions | PacedOptions) & ReadyOptions<A, E2, R2>) | undefined
): Effect.Effect<never, E | E2 | E3, Exclude<R | R2, Scope.Scope>> =>
  // Closed however `ready` or the loop ends, with nothing between the making
  // and them that an interruption could slip into.
  Effect.scoped(
    Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(restore(made), (target) =>
        Effect.ensuring(
          restore(
            Effect.andThen(
              options?.ready?.(target) ?? Effect.void,
              loop(paceOf(target, options))
            )
          ),
          target.close
        )
      )
    )
  );

/**
 * Runs a game until interrupted: makes its app, runs it, and closes the app
 * when it ends. It is a game's usual entry point.
 *
 *   const Duel = App.define({ plugins: [Game] })
 *   Browser.runMain(Driver.run(Duel, { hz: 60, seed: 1 }), {
 *     target: canvas,
 *   })
 *
 * It takes the options of `App.make` beside its own, `seed` or `save` among
 * them, and runs `frames` on the app it makes: once per repaint, the ticks
 * due at `hz`, then the frame stage. It never ends on its own. A program that
 * makes its app itself runs `frames` instead, and closes the app itself.
 *
 * Interrupting it stops the loop and closes the app. No frame is left
 * requested, no device is listened to, and everything the plugins' layers
 * acquired is released. It also closes the app when a tick or a frame fails
 * or dies. The platform's `runMain` interrupts it when the page closes or the
 * process is told to stop.
 *
 * To connect something to the app before its first frame, such as a button
 * that dispatches or a menu that saves, give it as `ready`:
 * `Driver.run(Duel, { hz: 60, ready: (app) => ... })`. What `ready` acquires
 * in its scope is released when the run ends, after the app is closed. When
 * `ready` fails, the run closes the app and fails with it.
 *
 * Provide what the game needs from outside to `Driver.run` as a whole, so it
 * stays provided for as long as the game runs. It fails with what making the
 * app, `ready`, a tick or a frame fails with, so a program catches what the
 * game's systems fail with by its tag, and dies with what one of them dies
 * with.
 *
 * Outside a page, the display is a timer, so
 * `NodeRuntime.runMain(Driver.run(...))` runs the same game under Node.
 *
 * Given an effect that makes a session connected to its transport, it runs
 * at the session's own `delta`, and takes neither `hz` nor `ticks`. It
 * closes the connection when it ends, and the connection's `close` closes
 * the session. It fails with what the session's tick fails with: what the
 * game's systems fail with, `Drift.Unlike`, `Drift.Drifted`,
 * `Save.Refused` and `Transport.Left`.
 *
 * @category Running
 */
export function run<
  S extends App.Systems = readonly [],
  H extends App.Handlers = readonly [],
  P extends App.Plugins = readonly [],
  SV extends Save.Save | undefined = undefined,
  E2 = never,
  R2 = never,
>(
  game: App.Game<S, H, P>,
  options: StepOptions &
    App.StartOptions<SV> &
    ReadyOptions<App.App<App.TickError<S, P>, App.AllHandlers<H, P>>, E2, R2>
): Effect.Effect<
  never,
  | Plugin.ErrorOf<P[number]>
  | (SV extends Save.Save ? Save.LoadRefused : never)
  | E2
  | App.TickError<S, P>,
  Exclude<App.External<S, H, P> | R2, Scope.Scope>
>;
export function run<
  A extends Paced<unknown> & Closes,
  E,
  R,
  E2 = never,
  R2 = never,
>(
  session: Effect.Effect<A, E, R>,
  options?: PacedOptions & ReadyOptions<A, E2, R2>
): Effect.Effect<never, E | E2 | FailureOf<A>, Exclude<R | R2, Scope.Scope>>;
export function run<
  S extends App.Systems,
  H extends App.Handlers,
  P extends App.Plugins,
  E,
  R,
  E2,
  R2,
  E3,
>(
  target: App.Game<S, H, P> | Effect.Effect<Paced<E3> & Closes, E, R>,
  options?: (StepOptions | PacedOptions) &
    App.StartOptions<Save.Save | undefined> & {
      // A method, which the compiler compares both ways, so that both
      // signatures' `ready` fit this one.
      ready?(
        made: (Tickable<unknown> | Paced<unknown>) & Closes
      ): Effect.Effect<unknown, E2, R2>;
    }
) {
  return Effect.isEffect(target)
    ? runMade<E3, Paced<E3> & Closes, E, R, E2, R2>(target, options)
    : runMade<
        App.TickError<S, P>,
        App.App<App.TickError<S, P>, App.AllHandlers<H, P>>,
        Plugin.ErrorOf<P[number]> | Save.LoadRefused,
        App.External<S, H, P>,
        E2,
        R2
      >(App.make(target, options), options);
}
