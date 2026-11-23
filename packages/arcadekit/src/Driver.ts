/**
 * Drivers decide when the app ticks. The app itself only exposes `tick(delta)`,
 * which is what lets the same game run in real time, turn by turn, or as fast
 * as possible in a test.
 *
 *   Driver.run(App.make(Duel), { hz: 60 })           // the usual entry point
 *   const step = Driver.fixedStep(app, { hz: 60 })   // by hand: step(seconds)
 *   yield* Driver.frames(app, { hz: 60 })            // in a page, once per repaint
 *   yield* Driver.interval(app, { hz: 60 })          // on a timer
 *
 * A session ticks by the `delta` every peer of it is made with, so a driver
 * given one is given no rate: `Driver.frames(session)`.
 */
import { Clock, Context, Duration, Effect, Schedule } from "effect";
import type { Scope } from "effect";

/**
 * Anything with a `tick` that is given how long a tick is, so drivers work
 * with every kind of app.
 *
 * @category Models
 */
export interface Tickable {
  readonly tick: (delta: number) => void;
  /**
   * An app's input stage, run just before each tick if present: a tick reads
   * no device, so this is where the game hears them.
   */
  readonly input?: () => void;
  /** An app's frame stage, run after each call's ticks if present. */
  readonly frame?: (alpha: number, delta?: number) => void;
  /**
   * Whether nothing is waiting for a tick, as the app reports it. Only read
   * when ticking when needed; a tickable without it is treated as needing every
   * tick.
   */
  readonly settled?: boolean;
  /** None: what ticks by a `delta` of its own is `Paced`. */
  readonly delta?: never;
}

/**
 * Anything that ticks by a `delta` of its own: a session, or a session
 * connected to a transport. A driver runs it at `1 / delta` ticks a second,
 * and is given neither `hz` nor `ticks`.
 *
 * @category Models
 */
export interface Paced {
  /** The seconds each of its ticks simulates. */
  readonly delta: number;
  /** Runs its next tick: its input stage, then the tick, if it can run. */
  readonly tick: () => void;
  /** Its frame stage, run after each call's ticks. */
  readonly frame: (alpha: number, delta?: number) => void;
}

/**
 * Options for how a driver steps an app.
 *
 * @category Options
 */
export interface StepOptions {
  /** The ticks per second the game runs at, whatever the frame rate. */
  readonly hz: number;
  /**
   * The maximum ticks one call runs after a stall. Defaults to 5. Ticks still
   * owed after that are dropped, so a page that froze doesn't race to catch up.
   */
  readonly maxStepsPerCall?: number;
  /**
   * When the game ticks.
   *
   * `"always"`, the default: at `hz`, in real time.
   *
   * `"whenNeeded"`: only while the game changes, for a game that moves only
   * when its player does. The input stage runs every frame, so a key press, a
   * UI button or a message is handled immediately. While the app isn't
   * settled (its last tick changed more than its time, an action is queued or
   * was dispatched, a state transition is pending, or an event hasn't been read
   * by every system) it ticks at `hz` like any game. Then it rests: no tick
   * runs, game time stands still, and the frame stage keeps drawing, with the
   * frame at the last tick (`Frame.alpha` of 1). Telling whether a tick
   * changed the game costs a hash of the world each tick: about 10 µs for a
   * thousand entities.
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
  /** As for an app: see `StepOptions`. */
  readonly maxStepsPerCall?: number;
  /** None, and its type is what the compiler says of one. */
  readonly hz?: "A session ticks 1 / delta times a second, the same on every peer: give its driver no hz.";
  /** None, and its type is what the compiler says of one. */
  readonly ticks?: "A session ticks continuously, since the other peers wait for its messages: give its driver no ticks.";
}

/** How a driver steps what it is given: how long a tick is, and whether it rests. */
interface Pace {
  readonly app: Tickable;
  readonly dt: number;
  readonly maxSteps: number;
  readonly whenNeeded: boolean;
}

/** Returns how a driver steps an app at `hz`, or a session at its own `delta`. */
const paceOf = (
  target: Tickable | Paced,
  options: StepOptions | PacedOptions | undefined
): Pace => {
  const maxSteps = options?.maxStepsPerCall ?? 5;
  if (target.delta !== undefined) {
    // A session reads its devices in its own tick.
    return {
      app: { tick: () => target.tick(), frame: target.frame },
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
const stepper = ({
  app,
  dt,
  maxSteps,
  whenNeeded,
}: Pace): ((realDelta: number) => number) => {
  let accumulator = 0;
  // Whether the call before this one found the game at rest.
  let resting = false;
  return (realDelta) => {
    // The time spent at rest is not owed. A game at rest has one tick
    // ready, so that the tick a move asks for runs in the frame the move
    // arrives in, and no more than that one.
    accumulator = resting ? dt : accumulator + realDelta;
    resting = false;
    let steps = 0;
    // The epsilon stops float error from swallowing a tick: 1 - 59 * (1 / 60)
    // is a hair less than 1 / 60.
    while (accumulator + EPSILON >= dt && steps < maxSteps) {
      app.input?.();
      if (whenNeeded) {
        // Asked after the input stage, which is where a move comes in.
        if (app.settled === true) {
          resting = true;
          break;
        }
      }
      app.tick(dt);
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
    app.frame?.(Math.min(1, accumulator / dt), realDelta);
    return steps;
  };
};

/**
 * Steps an app on a fixed timestep. Call it once per frame with the real
 * elapsed seconds; it runs zero or more ticks of exactly `1 / hz`, each after
 * the app's input stage, then runs the app's frame stage, and returns the
 * number of ticks it ran.
 *
 * The input stage reads the devices once per tick, so each tick sees one
 * consistent state of them, and a frame with no tick due reads nothing: input
 * from that frame is there for the next tick.
 *
 * The simulation ticks at a fixed rate whatever the frame rate, and the frame
 * stage receives how far its frame is between the last tick and the next
 * (`Frame.alpha`), so it can interpolate what moves.
 *
 * With `ticks: "whenNeeded"`, it ticks only while the app has pending work, and
 * rests in between: see `StepOptions`.
 *
 * A session is stepped the same way, with ticks of its own `delta`, and is
 * given neither `hz` nor `ticks`: `Driver.fixedStep(session)`.
 *
 * @category Running
 */
export function fixedStep(
  app: Tickable,
  options: StepOptions
): (realDelta: number) => number;
export function fixedStep(
  session: Paced,
  options?: PacedOptions
): (realDelta: number) => number;
export function fixedStep(
  target: Tickable | Paced,
  options?: StepOptions | PacedOptions
): (realDelta: number) => number {
  return stepper(paceOf(target, options));
}

/** Returns what `interval` returns for a pace. */
const beat = (pace: Pace): Effect.Effect<never> =>
  Effect.gen(function* () {
    const advance = stepper(pace);
    const period = Duration.millis(pace.dt * 1000);
    let last = yield* Clock.currentTimeNanos;
    const step = Effect.flatMap(Clock.currentTimeNanos, (now) =>
      Effect.sync(() => {
        advance(Number(now - last) / 1e9);
        last = now;
      })
    );
    // The first beat a period from now, as a timer's.
    yield* Effect.schedule(step, Schedule.fixed(period));
    return yield* Effect.never;
  });

/**
 * Ticks on a timer until interrupted, then stops the timer. In a page, use
 * `frames`, which follows the display.
 *
 * Each beat of the timer is one `fixedStep` call: the input stage and the ticks
 * that are due, then the frame stage. If a tick or a frame throws, the timer
 * stops and the effect dies with the thrown error. The timer runs on Effect's
 * `Clock`, so a test moves it on with `TestClock`. A session beats once per
 * tick of its own `delta`, and is given neither `hz` nor `ticks`.
 *
 * @category Running
 */
export function interval(
  app: Tickable,
  options: StepOptions
): Effect.Effect<never>;
export function interval(
  session: Paced,
  options?: PacedOptions
): Effect.Effect<never>;
export function interval(
  target: Tickable | Paced,
  options?: StepOptions | PacedOptions
): Effect.Effect<never> {
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
 * The screen a frame loop follows. Nothing has to provide it: the default is a
 * 60 frames per second timer, which is all there is under Node, in a worker or
 * on a server. A page provides its own, based on `requestAnimationFrame` and
 * the document's visibility, with `Browser.layer()` or `Browser.runMain` from
 * `arcadekit/Browser`. A test provides one it advances by hand:
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
   * Signals that a frame is due at `now` milliseconds: calls every pending
   * callback, and returns how many it called. Callbacks requested meanwhile
   * wait for the next frame.
   */
  readonly frame: (now: number) => number;
  /** Hides the tab: `hidden` returns true, and listeners are notified. */
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
const loop = Effect.fnUntraced(function* (pace: Pace) {
  const display = yield* Display;
  return yield* Effect.callback<never>((resume) => {
    const advance = stepper(pace);
    // When the frame before this one was, or undefined when time starts
    // over: at the first frame, and after the tab was hidden.
    let last: number | undefined;
    let takeBack: (() => void) | undefined;
    let unwatch = (): void => {};
    let stopped = false;
    const stop = (): void => {
      stopped = true;
      takeBack?.();
      takeBack = undefined;
      unwatch();
    };
    const onFrame = (now: number): void => {
      takeBack = undefined;
      if (stopped) {
        return;
      }
      if (display.hidden()) {
        // Paused. Whoever watches the tab asks again when it is shown.
        last = undefined;
        return;
      }
      const delta = last === undefined ? 0 : Math.max(0, (now - last) / 1000);
      last = now;
      try {
        advance(delta);
      } catch (error) {
        stop();
        resume(Effect.die(error));
        return;
      }
      takeBack = display.request(onFrame);
    };
    unwatch = display.onVisibilityChange(() => {
      if (stopped) {
        return;
      }
      if (display.hidden()) {
        takeBack?.();
        takeBack = undefined;
        last = undefined;
      } else if (takeBack === undefined) {
        takeBack = display.request(onFrame);
      }
    });
    if (!display.hidden()) {
      takeBack = display.request(onFrame);
    }
    return Effect.sync(stop);
  });
});

/**
 * Runs the frame loop: follows the display until interrupted. Each time a frame
 * is due, it runs the ticks that are due at a fixed `hz`, then the app's frame
 * stage, as `fixedStep` does. In a page, with the page's display, a frame is
 * due once per repaint (`requestAnimationFrame`).
 *
 *   const app = yield* Effect.acquireRelease(App.make(Game), (app) => app.close)
 *   yield* Driver.frames(app, { hz: 60 })
 *
 * It does not close the app it is given, which is its maker's: `Driver.run`
 * is the loop that makes its app and closes it.
 *
 * A session runs the ticks that are due at its own `delta`, and is given
 * neither `hz` nor `ticks`:
 *
 *   yield* Driver.frames(yield* Transport.connect(session))
 *
 * - The first frame draws the game as it is and runs no tick: time is measured
 *   from it.
 * - While the tab is hidden, the loop requests no frames, and the hidden time
 *   doesn't count: a game that becomes visible again resumes where it was.
 * - Interrupting it cancels its pending frame request and stops watching the
 *   tab, so nothing is left running. It is interrupted with the fiber that runs
 *   it.
 * - If a tick or a frame throws, it stops the same way and dies with the thrown
 *   error.
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
export function frames(
  app: Tickable,
  options: StepOptions
): Effect.Effect<never>;
export function frames(
  session: Paced,
  options?: PacedOptions
): Effect.Effect<never>;
export function frames(
  target: Tickable | Paced,
  options?: StepOptions | PacedOptions
): Effect.Effect<never> {
  return loop(paceOf(target, options));
}

/**
 * What `Driver.run` closes when it ends: an app, a session, or a session
 * connected to a transport.
 *
 * @category Models
 */
export interface Closes {
  /** Lets go of everything it opened. */
  readonly close: Effect.Effect<void>;
}

/**
 * Runs an app until interrupted, from the effect that makes it, and closes
 * it when it ends. This is the usual entry point.
 *
 *   const Duel = App.define({ plugins: [Game] })
 *   Browser.runMain(Driver.run(App.make(Duel, { seed: 1 }), { hz: 60 }), {
 *     target: canvas,
 *   })
 *
 * It is `frames` on the app it makes: the frame loop follows the display,
 * running the ticks that are due at `hz`, then the frame stage, once per
 * repaint. It never ends on its own. `frames` is the same loop for a program
 * that makes its app itself, and closes it itself.
 *
 * Interrupting it stops the loop and closes the app, so nothing is left
 * running: no pending frame, no device listened to, and everything the
 * plugins' layers acquired is released. It closes the app as well when a
 * tick throws. The platform's `runMain` interrupts it when the page closes
 * or the process is told to stop.
 *
 * What is to be connected to the app before its first frame, a button that
 * dispatches or a menu that saves, is a step of the effect that makes it:
 * `App.make(Duel).pipe(Effect.tap((app) => ...))`. What that step acquires in
 * its scope is released when the run ends, after the app is closed. A step
 * that can fail holds the app in that scope, so that it is closed when the
 * step fails, before the run has it: `Effect.acquireRelease(App.make(Duel),
 * (app) => app.close).pipe(Effect.tap(...))`.
 *
 * Provide what the game needs from outside to `Driver.run` as a whole, so
 * that it stays provided for as long as the game runs. It fails with what
 * making the app fails with, and dies with whatever a tick throws.
 *
 * It runs wherever there is a display, which outside a page is a timer:
 * `NodeRuntime.runMain(Driver.run(...))` runs the same game under Node.
 *
 * An effect that makes a session, connected to its transport, runs at the
 * session's own `delta`, and is given neither `hz` nor `ticks`. Closing the
 * connection closes the session.
 *
 * @category Running
 */
export function run<A extends Tickable & Closes, E, R>(
  app: Effect.Effect<A, E, R>,
  options: StepOptions
): Effect.Effect<never, E, Exclude<R, Scope.Scope>>;
export function run<A extends Paced & Closes, E, R>(
  session: Effect.Effect<A, E, R>,
  options?: PacedOptions
): Effect.Effect<never, E, Exclude<R, Scope.Scope>>;
export function run<E, R>(
  made: Effect.Effect<(Tickable | Paced) & Closes, E, R>,
  options?: StepOptions | PacedOptions
): Effect.Effect<never, E, Exclude<R, Scope.Scope>> {
  // Closed however the loop ends, with nothing between the making and the
  // loop that an interruption could slip into.
  return Effect.scoped(
    Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(restore(made), (target) =>
        Effect.ensuring(restore(loop(paceOf(target, options))), target.close)
      )
    )
  );
}
