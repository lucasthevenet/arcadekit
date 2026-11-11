import { Clock, Duration, Effect, Scheduler } from "effect";

// What a test on fake timers runs a Co-op client's Effects on. In Node, Effect reads its time
// from `process.hrtime` and runs its fibers on `setImmediate`. A test's fake timers reach
// neither, so a session's clock would stand still while its ticker's faked timer ran on, and a
// fiber would go on at some real moment the test doesn't await. A page has neither problem: its
// time is `performance.now()`, and Foldkit runs fibers on microtasks. This gives a test both.

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
 * Has `effect` run on the timers a test fakes, as a page runs it: its `Clock` reads
 * `performance.now()` and sleeps on `setTimeout`, and its fibers run on microtasks. A Co-op
 * client made in it steps its run by the faked time, so advancing the fake timers moves the
 * run's ticker and its clock together, and nothing waits on a timer the test can't advance.
 * Everything else of the Effect is as it was: what it gives, fails with and needs.
 *
 * Wrap every Effect the test runs or forks, the one that builds the client's layer first: what
 * a client forks later runs as that one did.
 *
 * ```ts
 * // With Vitest, in the test's `beforeEach`, and `vi.useRealTimers()` in its `afterEach`.
 * vi.useFakeTimers({
 *   toFake: ["setInterval", "clearInterval", "setTimeout", "performance"],
 * });
 *
 * const run = <A, E>(effect: Effect.Effect<A, E>) =>
 *   Effect.runPromise(onFakeTimers(effect));
 *
 * // `host` and `guest` are two players' clients, each built through `run`, over one
 * // `fakeCoopRooms()`, here `hub`.
 * await run(host.host("red"));
 * // Lets what woke run, at the faked time.
 * await vi.advanceTimersByTimeAsync(0);
 * await run(guest.join(hub.code, "green"));
 * // A lobby needs its second player before it can start.
 * await vi.advanceTimersByTimeAsync(0);
 * await run(host.start);
 * // Five seconds of the run.
 * await vi.advanceTimersByTimeAsync(5000);
 * ```
 *
 * It fakes nothing itself, and needs no test runner: it reads the globals as they are when the
 * Effect runs. Fake `performance` and `setTimeout`, and `setInterval` with `clearInterval` for
 * a run on the default ticker, which ticks on the page's timer where no worker starts, as in
 * Node. Leave `queueMicrotask` real. With `manualTicker`, the test ticks and the faked time is
 * still the run's.
 */
export const onFakeTimers = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.provideService(Clock.Clock, pageClock),
    Effect.provideService(Scheduler.Scheduler, microtasks)
  );
