/**
 * Drivers decide when the app ticks. The app itself only knows `tick(delta)`,
 * which is what makes the same game runnable in real time, turn by turn, or
 * as fast as possible in a test.
 *
 *   const step = Driver.fixedStep(app, { hz: 60 })   // by hand: step(seconds)
 *   yield* Driver.frames(app, { hz: 60 })            // in a page, once per repaint
 *   yield* Driver.interval(app, { hz: 60 })          // on a timer
 */
import { Context, Effect } from "effect";

/** Anything with a `tick`, so drivers work with every App type. */
export interface Tickable {
  readonly tick: (delta: number) => void;
  /** An app's frame stage: run after the ticks of each call, if it is there. */
  readonly frame?: (alpha: number, delta?: number) => void;
}

const EPSILON = 1e-9;

/**
 * Fixed-timestep stepping. Feed it real elapsed seconds, once per frame; it
 * runs zero or more ticks of exactly `1 / hz`, then the app's frame stage,
 * and returns how many ticks it ran.
 *
 * The simulation ticks at a fixed rate whatever the rate of frames, and the
 * frame stage is told how far its frame is between the last tick and the
 * next (`Frame.alpha`), so that it can draw what moves in between.
 */
export const fixedStep = (
  app: Tickable,
  options: { readonly hz: number; readonly maxStepsPerCall?: number }
): ((realDelta: number) => number) => {
  const dt = 1 / options.hz;
  const maxSteps = options.maxStepsPerCall ?? 5;
  let accumulator = 0;
  return (realDelta) => {
    accumulator += realDelta;
    let steps = 0;
    // The epsilon stops float error from swallowing a tick: 1 - 59 * (1 / 60)
    // is a hair less than 1 / 60.
    while (accumulator + EPSILON >= dt && steps < maxSteps) {
      app.tick(dt);
      accumulator = Math.max(0, accumulator - dt);
      steps++;
    }
    // After a long stall, drop the backlog instead of spiralling.
    if (steps === maxSteps && accumulator >= dt) {
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
 */
export const interval = (
  app: Tickable,
  options: { readonly hz: number }
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
 * What a frame loop needs of the screen it draws to: to be called back when
 * the next frame is due, and to know whether anyone can see it.
 */
export interface DisplayShape {
  /**
   * Asks to be called once, when the next frame is due, with the time in
   * milliseconds. Returns what takes the request back.
   */
  readonly request: (callback: (now: number) => void) => () => void;
  /** Whether nobody can see the game: its tab is hidden. */
  readonly hidden: () => boolean;
  /**
   * Calls `listener` whenever `hidden` may have changed. Returns what stops
   * it.
   */
  readonly onVisibilityChange: (listener: () => void) => () => void;
}

/**
 * The screen as the platform has it. In a page that is
 * `requestAnimationFrame` and the document's visibility. Anywhere else
 * (Node, a worker) it is a timer of 60 frames a second that is never
 * hidden. It holds nothing, and looks for the page each time it is asked.
 */
const platformDisplay: DisplayShape = {
  request(callback) {
    if (typeof requestAnimationFrame === "function") {
      const id = requestAnimationFrame(callback);
      return () => cancelAnimationFrame(id);
    }
    const id = setTimeout(() => callback(performance.now()), 1000 / 60);
    return () => clearTimeout(id);
  },
  hidden: () =>
    typeof document !== "undefined" && document.visibilityState === "hidden",
  onVisibilityChange(listener) {
    if (typeof document === "undefined") {
      return () => {};
    }
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
};

/**
 * The screen a frame loop follows. Nothing has to provide it: the default
 * is the platform's. A test provides one it turns by hand:
 *
 *   const display = Driver.makeManualDisplay()
 *   Driver.frames(app, { hz: 60 }).pipe(Effect.provideService(Driver.Display, display))
 */
export const Display: Context.Reference<DisplayShape> =
  Context.Reference<DisplayShape>("arcadekit/Display", {
    defaultValue: () => platformDisplay,
  });

/** A display turned by hand, for tests and tools. */
export interface ManualDisplay extends DisplayShape {
  /**
   * A frame is due, at `now` milliseconds: calls whoever asked for it, and
   * returns how many did. What they ask for meanwhile waits for the next.
   */
  readonly frame: (now: number) => number;
  /** The tab is hidden: `hidden` says so, and whoever watches is told. */
  readonly hide: () => void;
  /** The tab is shown again. */
  readonly show: () => void;
  /** How many requests for a frame are waiting. */
  readonly pending: number;
  /** How many listeners are watching for a change of visibility. */
  readonly watching: number;
}

/**
 * A display that does nothing until it is told to: `frame(now)` runs the
 * frame that was asked for, `hide()` and `show()` are the tab going away and
 * coming back, and `pending` and `watching` say what a frame loop has left
 * behind.
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

/**
 * The frame loop: follows the display until interrupted. Each time a frame
 * is due it runs the ticks that are due, at a fixed `hz`, and then the
 * app's frame stage, as `fixedStep` does. In a page a frame is due once per
 * repaint (`requestAnimationFrame`).
 *
 *   const app = yield* App.make({ plugins: [Game] })
 *   yield* Driver.frames(app, { hz: 60 })
 *
 * - The first frame draws the game as it stands and runs no tick: time is
 *   counted from it.
 * - While the tab is hidden the loop asks for no frame, and the time spent
 *   hidden does not count: a game that comes back is where it was left.
 * - Interrupting it takes back the frame it had asked for and stops
 *   watching the tab, so nothing is left running. It is interrupted with
 *   the fiber that runs it, which is how closing a scope stops it.
 * - If a tick or a frame throws, it stops the same way and dies with what
 *   was thrown.
 *
 * It reaches the screen through `Display`, which a test replaces.
 */
export const frames: (
  app: Tickable,
  options: { readonly hz: number; readonly maxStepsPerCall?: number }
) => Effect.Effect<never> = Effect.fnUntraced(function* (
  app: Tickable,
  options: { readonly hz: number; readonly maxStepsPerCall?: number }
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
