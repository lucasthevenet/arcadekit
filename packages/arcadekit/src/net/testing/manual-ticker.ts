import { Effect, Layer } from "effect";

import { CoopTicker } from "../browser/index";
import type { Ticker } from "../scoped";

/**
 * A `Ticker` a test drives: nothing ticks until the test calls `tick`. Provide `layer` to a
 * `Coop`'s layer, or pass `ticker` to a scoped lockstep session's `run`. Time is not its part: a
 * tick reads the Clock the session was made on, so move that first.
 *
 * ```ts
 * const ticks = manualTicker();
 * MyCoop.layer.pipe(Layer.provide(ticks.layer));
 * ticks.tick();
 * ```
 */
export const manualTicker = (): {
  readonly ticker: Ticker;
  /** Provides the `CoopTicker` reference with `ticker`: every run of a `Coop` then ticks on it. */
  readonly layer: Layer.Layer<never>;
  /** Ticks everything now ticking, once. */
  readonly tick: () => void;
  /** How many runs it is ticking now: started and not stopped. */
  readonly ticking: () => number;
} => {
  const running = new Set<() => void>();
  const ticker: Ticker = (onTick) => {
    // Its own function, so one callback started twice is two runs.
    const tick = () => onTick();
    running.add(tick);
    return () => {
      running.delete(tick);
    };
  };
  return {
    ticker,
    layer: Layer.succeed(CoopTicker, Effect.succeed(ticker)),
    tick: () => {
      // A run a tick stops before its turn is not ticked: a Set skips what was deleted.
      for (const tick of running) {
        tick();
      }
    },
    ticking: () => running.size,
  };
};
