/**
 * Page timers: the Clock and the scheduler a test on fake timers runs a Co-op client's Effects on.
 *
 * In Node, Effect reads its time from `process.hrtime` and runs its fibers on `setImmediate`, and
 * a test's fake timers reach neither: a session's clock would stand still while its ticker's
 * faked timer ran on, and a fiber would go on at some real moment the test doesn't await. A page
 * has neither problem: its time is `performance.now()`, and Foldkit runs fibers on microtasks.
 * `layer` gives a test both, as services of Effect's: it is named for its mechanism, the page's
 * timers, as Effect's `FetchHttpClient` is for its own. It fakes nothing itself: it reads the
 * globals as they are when the Effect runs.
 *
 * @since 0.7.0
 */
import { Clock, Duration, Effect, Layer, Scheduler } from "effect";

const nanos = (ms: number): bigint => BigInt(Math.round(ms * 1_000_000));

/**
 * Effect's Clock on the page's timers, which a test fakes: `performance.now()` for the time a
 * run steps by, `Date.now()` for the time of day, and `setTimeout` for a sleep.
 */
const pageClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => Date.now(),
  currentTimeMillis: Effect.sync(() => Date.now()),
  currentTimeNanosUnsafe: () => nanos(Date.now()),
  currentTimeNanos: Effect.sync(() => nanos(Date.now())),
  monotonicTimeNanosUnsafe: () => nanos(performance.now()),
  monotonicTimeNanos: Effect.sync(() => nanos(performance.now())),
  sleep: (duration) =>
    Effect.callback((resume) => {
      const timer = setTimeout(
        () => resume(Effect.void),
        Duration.toMillis(duration)
      );
      return Effect.sync(() => clearTimeout(timer));
    }),
};

/** Runs fibers on microtasks, as Foldkit's scheduler does in the browser. */
const microtasks: Scheduler.Scheduler = new Scheduler.MixedScheduler(
  "async",
  (task) => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        task();
      }
    });
    return () => {
      cancelled = true;
    };
  }
);

/**
 * Provides Effect's `Clock` and `Scheduler` on the page's timers, as a page runs an Effect: its
 * Clock reads `performance.now()` and sleeps on `setTimeout`, and its fibers run on microtasks.
 *
 * **When to use**
 *
 * In a test of a Co-op client on fake timers: provide it to every Effect the test runs or forks,
 * the one that builds the client's layer first, since a client takes its Clock and its scheduler
 * from the Effect that made it, and what it forks later runs as that one did. Advancing the fake
 * timers then moves a run's ticker and its clock together, and nothing waits on a timer the test
 * can't advance.
 *
 * **Details**
 *
 * Fake `performance` and `setTimeout`, and `setInterval` with `clearInterval` for a run on the
 * default ticker, which ticks on the page's timer where no worker starts, as in Node. Leave
 * `queueMicrotask` real. With a `ManualTicker` the test ticks, and the faked time is still the
 * run's: move the time, then tick. Nothing else of the Effect changes: what it gives, fails with
 * and needs.
 *
 * **Example** (A run's time, from the page's clock)
 *
 * ```ts
 * import { PageTimers } from "arcadekit/net/testing";
 * import { Clock, Effect } from "effect";
 *
 * // With Vitest, fake the timers first, in `beforeEach`:
 * //   vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "performance"] });
 * const run = <A, E>(effect: Effect.Effect<A, E>): A =>
 *   Effect.runSync(effect.pipe(Effect.provide(PageTimers.layer)));
 * const before = performance.now();
 * const nanos = run(Clock.clockWith((clock) => Effect.succeed(clock.monotonicTimeNanosUnsafe())));
 * Number(nanos) / 1_000_000 >= before; // => true
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export const layer: Layer.Layer<never> = Layer.mergeAll(
  Layer.succeed(Clock.Clock, pageClock),
  Layer.succeed(Scheduler.Scheduler, microtasks)
);
