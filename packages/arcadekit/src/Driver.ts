/**
 * Drivers decide when the app ticks. The app itself only knows `tick(delta)`,
 * which is what makes the same game runnable in real time, turn by turn, or
 * as fast as possible in a test.
 */
import { Effect } from "effect";

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
 * Ticks on a timer until interrupted, then stops the timer. In a browser the
 * same shape wraps `requestAnimationFrame`.
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
