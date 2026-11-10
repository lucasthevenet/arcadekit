import type { Ticker } from "../scoped";

/**
 * A `Ticker` a test drives: nothing ticks until the test calls `tick`. Pass `ticker` to
 * `makeCoopClient(game, { ticker })`, or to a scoped lockstep session's `run`. Time is not its
 * part: a tick reads the Clock the session was made on, so move that first.
 */
export const manualTicker = (): {
  readonly ticker: Ticker;
  /** Ticks everything now ticking, once. */
  readonly tick: () => void;
  /** How many runs it is ticking now: started and not stopped. */
  readonly ticking: () => number;
} => {
  const running = new Set<() => void>();
  return {
    ticker: (onTick) => {
      // Its own function, so one callback started twice is two runs.
      const tick = () => onTick();
      running.add(tick);
      return () => {
        running.delete(tick);
      };
    },
    tick: () => {
      // A run a tick stops before its turn is not ticked: a Set skips what was deleted.
      for (const tick of running) {
        tick();
      }
    },
    ticking: () => running.size,
  };
};
