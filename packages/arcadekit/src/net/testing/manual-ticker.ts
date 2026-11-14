/**
 * Manual tickers: a ticker a test drives, for a lockstep run or a Co-op client.
 *
 * Nothing ticks until the test calls `tick`. It is the bridge a scoped session's `run` waits on,
 * run by a test, as `arcadekit/game/testing`'s `ManualFrames` is an engine's: a tick runs every
 * ticking session in the test's own call. Time is not its part: a tick reads the Clock the
 * session was made on, so a test moves that first.
 *
 * @since 0.7.0
 */
import { Effect, Inspectable, Layer, Pipeable, Predicate } from "effect";
import type { Types } from "effect";

import { CoopTicker } from "../browser/index";
import type * as Ticker from "../ticker";

const TypeId = "~arcadekit/net/testing/ManualTicker";

/**
 * A ticker a test drives: `ticker` is what a session's `run` or a Co-op client ticks on, and
 * `tick` ticks every run now ticking on it, once.
 *
 * **When to use**
 *
 * In a test of a lockstep run that ticks by hand, and in a test of a co-op game, through
 * `layer`, so its runs tick when the test says.
 *
 * **Details**
 *
 * Each `onTick` it is given is a run of its own, until that run stops it: one callback started
 * twice is two runs. A run a tick stops before its turn is not ticked.
 *
 * **Example** (Two ticks)
 *
 * ```ts
 * import { ManualTicker } from "arcadekit/net/testing";
 *
 * const timer = ManualTicker.make();
 * let ticks = 0;
 * const stop = timer.ticker(() => {
 *   ticks += 1;
 * });
 * ManualTicker.tick(timer);
 * ManualTicker.tick(timer);
 * stop();
 * ManualTicker.tick(timer);
 * ticks; // => 2
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export interface ManualTicker
  extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  /** The ticker a run ticks on. */
  readonly ticker: Ticker.Ticker;
}

/** What the module's functions keep, which no caller reads. */
type Internal = Types.Mutable<ManualTicker> & {
  readonly running: Set<() => void>;
};

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: Internal) {
    return { _id: "ManualTicker", ticking: this.running.size };
  },
};

/**
 * Checks whether a value is a manual ticker.
 *
 * **When to use**
 *
 * Narrow an unknown value before ticking it.
 *
 * **Example** (Recognising a manual ticker)
 *
 * ```ts
 * import { ManualTicker } from "arcadekit/net/testing";
 *
 * ManualTicker.isManualTicker(ManualTicker.make()); // => true
 * ManualTicker.isManualTicker({ ticker: () => () => {} }); // => false
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export const isManualTicker = (value: unknown): value is ManualTicker =>
  Predicate.hasProperty(value, TypeId);

/**
 * Makes a ticker that ticks nothing until the test calls `tick`.
 *
 * **When to use**
 *
 * Once per test, before the runs it ticks.
 *
 * **Example** (A ticker with no run)
 *
 * ```ts
 * import { ManualTicker } from "arcadekit/net/testing";
 *
 * const timer = ManualTicker.make();
 * ManualTicker.ticking(timer); // => 0
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export const make = (): ManualTicker => {
  const self = Object.create(Proto) as Internal;
  const running = new Set<() => void>();
  Object.assign(self, {
    running,
    ticker: (onTick: () => void) => {
      // Its own function, so one callback started twice is two runs.
      const tick = () => onTick();
      running.add(tick);
      return () => {
        running.delete(tick);
      };
    },
  });
  return self;
};

/**
 * Ticks every run now ticking on the ticker, once, in the order they started.
 *
 * **When to use**
 *
 * In a test, after it moves the time the runs read: each tick runs the steps that time says are
 * due.
 *
 * **Details**
 *
 * A run a tick stops before its turn is not ticked: the runs are a set, which skips what was
 * deleted.
 *
 * **Example** (A tick reaches every run)
 *
 * ```ts
 * import { ManualTicker } from "arcadekit/net/testing";
 *
 * const timer = ManualTicker.make();
 * const heard: string[] = [];
 * timer.ticker(() => heard.push("host"));
 * timer.ticker(() => heard.push("guest"));
 * ManualTicker.tick(timer);
 * heard; // => ["host", "guest"]
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export const tick = (self: ManualTicker): void => {
  for (const run of (self as Internal).running) {
    run();
  }
};

/**
 * How many runs the ticker is ticking now: started, and not stopped.
 *
 * **When to use**
 *
 * In a test of what stops a run's ticker: a run that ends, or a seat that is left.
 *
 * **Example** (A run that stopped its ticker)
 *
 * ```ts
 * import { ManualTicker } from "arcadekit/net/testing";
 *
 * const timer = ManualTicker.make();
 * const stop = timer.ticker(() => {});
 * ManualTicker.ticking(timer); // => 1
 * stop();
 * ManualTicker.ticking(timer); // => 0
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export const ticking = (self: ManualTicker): number =>
  (self as Internal).running.size;

/**
 * Provides `CoopTicker` with the ticker: every run of a `Coop` then ticks on it.
 *
 * **When to use**
 *
 * Under a `Coop`'s `layer` in a test, in place of the worker's timer a browser ticks on.
 *
 * **Example** (The ticker a client's runs get)
 *
 * ```ts
 * import { CoopTicker } from "arcadekit/net/browser";
 * import { ManualTicker } from "arcadekit/net/testing";
 * import { Effect } from "effect";
 *
 * const timer = ManualTicker.make();
 * const program = Effect.gen(function* () {
 *   return (yield* yield* CoopTicker.CoopTicker) === timer.ticker;
 * });
 * Effect.runSync(program.pipe(Effect.scoped, Effect.provide(ManualTicker.layer(timer)))); // => true
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export const layer = (self: ManualTicker): Layer.Layer<never> =>
  Layer.succeed(CoopTicker.CoopTicker, Effect.succeed(self.ticker));
