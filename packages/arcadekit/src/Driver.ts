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

/**
 * Anything with a `tick`, so drivers work with every App type.
 *
 * @category Models
 */
export interface Tickable {
  readonly tick: (delta: number) => void;
  /**
   * An app's input stage: run just before each tick, if it is there. An
   * app's own tick would run it too; a driver does it first, so that it
   * can ask whether the game is settled once a move has come in.
   */
  readonly input?: () => void;
  /** An app's frame stage: run after the ticks of each call, if it is there. */
  readonly frame?: (alpha: number, delta?: number) => void;
  /**
   * Whether nothing is waiting for a tick: an app says so. Asked only when
   * ticking when needed; what does not say is taken to need every tick.
   */
  readonly settled?: boolean;
}

/**
 * How a driver steps an app.
 *
 * @category Options
 */
export interface StepOptions {
  /** How many ticks a second the game runs at, whatever the rate of frames. */
  readonly hz: number;
  /** The most ticks one call runs after a stall. 5 when left out. */
  readonly maxStepsPerCall?: number;
  /**
   * When the game ticks.
   *
   * `"always"`, when left out: at `hz`, in real time.
   *
   * `"whenNeeded"`: only while something is waiting for a tick, for a game
   * that moves when its player does. The input stage runs every frame, so
   * a key, a button of the UI or a message is heard at once. While the app
   * is not settled (an action waits, a state is to be entered, a script
   * waits for a tick, an event has not been heard by every system) it
   * ticks at `hz` as any game does, and once more after, for the systems
   * that react a tick late to what a system after them did. Then it rests:
   * no tick runs, the game's time stands still, and the frame stage goes
   * on drawing it, told that the frame is all the way to the last tick
   * (`Frame.alpha` of 1).
   */
  readonly ticks?: "always" | "whenNeeded";
}

const EPSILON = 1e-9;

/**
 * Fixed-timestep stepping. Feed it real elapsed seconds, once per frame; it
 * runs zero or more ticks of exactly `1 / hz`, each after the app's input
 * stage, then the app's frame stage, and returns how many ticks it ran.
 *
 * The input stage reads the devices once per tick, so that a tick sees one
 * picture of them, and a frame in which no tick is due reads nothing: what
 * was pressed meanwhile is there for the next tick.
 *
 * The simulation ticks at a fixed rate whatever the rate of frames, and the
 * frame stage is told how far its frame is between the last tick and the
 * next (`Frame.alpha`), so that it can draw what moves in between.
 *
 * With `ticks: "whenNeeded"` it ticks only while the app has something
 * waiting, and rests in between: see `StepOptions`.
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
 * Ticks on a timer until interrupted, then stops the timer. In a page, use
 * `frames`, which follows the display.
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
 * What a frame loop needs of the screen it draws to: to be called back when
 * the next frame is due, and to know whether anyone can see it.
 *
 * @category Services
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
 * A screen there is none of: a timer of 60 frames a second, never hidden.
 * It holds nothing.
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
 * The screen a frame loop follows. Nothing has to provide it: the default
 * is a timer of 60 frames a second, which is all there is under Node, in a
 * worker or on a server. A page provides its own, `requestAnimationFrame`
 * and the document's visibility, with `Browser.layer()` or
 * `Browser.runMain` from `arcadekit/Browser`. A test provides one it turns
 * by hand:
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
 * A display turned by hand, for tests and tools.
 *
 * @category Testing
 */
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

/**
 * The frame loop: follows the display until interrupted. Each time a frame
 * is due it runs the ticks that are due, at a fixed `hz`, and then the
 * app's frame stage, as `fixedStep` does. In a page, with the page's
 * display, a frame is due once per repaint (`requestAnimationFrame`).
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
 * - With `ticks: "whenNeeded"`, for a game that moves when its player
 *   does, every frame is drawn and a tick runs only while something is
 *   waiting for one:
 *
 *     yield* Driver.frames(app, { hz: 60, ticks: "whenNeeded" })
 *
 * It reaches the screen through `Display`, which a test replaces.
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
