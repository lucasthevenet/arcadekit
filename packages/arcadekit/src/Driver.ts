/**
 * Drivers decide when the app ticks. The app itself only exposes `tick(delta)`,
 * which is what lets the same game run in real time, turn by turn, or as fast
 * as possible in a test.
 *
 *   const step = Driver.fixedStep(app, { hz: 60 })   // by hand: step(seconds)
 *   yield* Driver.frames(app, { hz: 60 })            // in a page, once per repaint
 *   yield* Driver.interval(app, { hz: 60 })          // on a timer
 */
import { Context, Effect } from "effect";

/**
 * Anything with a `tick`, so drivers work with every kind of app.
 *
 * @category Models
 */
export interface Tickable {
  readonly tick: (delta: number) => void;
  /**
   * An app's input stage, run just before each tick if present. An app's own
   * tick would run it too; a driver runs it first, so it can check whether the
   * game is settled after input arrives.
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
   * `"whenNeeded"`: only while something is waiting for a tick, for a game that
   * moves only when its player does. The input stage runs every frame, so a key
   * press, a UI button or a message is handled immediately. While the app isn't
   * settled (an action is queued, a state transition is pending, a script is
   * waiting for a tick, or an event hasn't been read by every system) it ticks
   * at `hz` like any game, plus one more tick for systems that react a tick
   * late to what a later system did. Then it rests: no tick runs, game time
   * stands still, and the frame stage keeps drawing, with the frame at the last
   * tick (`Frame.alpha` of 1).
   */
  readonly ticks?: "always" | "whenNeeded";
}

const EPSILON = 1e-9;

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
 * @category Running
 */
export const fixedStep = (
  app: Tickable,
  options: StepOptions
): ((realDelta: number) => number) => {
  const dt = 1 / options.hz;
  const maxSteps = options.maxStepsPerCall ?? 5;
  const whenNeeded = options.ticks === "whenNeeded";
  let accumulator = 0;
  // Ticking when needed: whether the last tick had something waiting for
  // it, in which case one more follows it.
  let settling = false;
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
        const needed = app.settled !== true;

        if (!needed && !settling) {
          resting = true;
          break;
        }

        settling = needed;
      }

      app.tick(dt);
      accumulator = Math.max(0, accumulator - dt);
      steps += 1;
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
 * Ticks on a timer until interrupted, then stops the timer. In a page, use
 * `frames`, which follows the display.
 *
 * Each timer callback is one `fixedStep` call: the input stage and the ticks
 * that are due, then the frame stage. If a tick or a frame throws, the timer
 * stops and the effect dies with the thrown error.
 *
 * @category Running
 */
export const interval = (
  app: Tickable,
  options: StepOptions
): Effect.Effect<never> =>
  Effect.callback<never>((resume) => {
    const advance = fixedStep(app, options);
    let last = performance.now();

    const id = setInterval(() => {
      const now = performance.now();

      try {
        advance((now - last) / 1000);
      } catch (error) {
        clearInterval(id);
        resume(Effect.die(error));
      }

      last = now;
    }, 1000 / options.hz);

    return Effect.sync(() => clearInterval(id));
  });

/**
 * What a frame loop needs from the screen it draws to: a callback when the next
 * frame is due, and whether anyone can see it.
 *
 * @category Services
 */
export interface Display {
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
const timerDisplay: Display = {
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
export const Display: Context.Reference<Display> = Context.Reference<Display>(
  "arcadekit/Display",
  {
    defaultValue: () => timerDisplay,
  }
);

/**
 * A display advanced by hand, for tests and tools.
 *
 * @category Testing
 */
export interface ManualDisplay extends Display {
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

    for (const listener of [...listeners]) {
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

/**
 * Runs the frame loop: follows the display until interrupted. Each time a frame
 * is due, it runs the ticks that are due at a fixed `hz`, then the app's frame
 * stage, as `fixedStep` does. In a page, with the page's display, a frame is
 * due once per repaint (`requestAnimationFrame`).
 *
 *   const app = yield* App.make({ plugins: [Game] })
 *   yield* Driver.frames(app, { hz: 60 })
 *
 * - The first frame draws the game as it is and runs no tick: time is measured
 *   from it.
 * - While the tab is hidden, the loop requests no frames, and the hidden time
 *   doesn't count: a game that becomes visible again resumes where it was.
 * - Interrupting it cancels its pending frame request and stops watching the
 *   tab, so nothing is left running. It is interrupted with the fiber that runs
 *   it, which is how closing a scope stops it.
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
export const frames: (
  app: Tickable,
  options: StepOptions
) => Effect.Effect<never> = Effect.fnUntraced(function* (
  app: Tickable,
  options: StepOptions
) {
  const display = yield* Display;

  return yield* Effect.callback<never>((resume) => {
    const advance = fixedStep(app, options);
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
