/**
 * Tickers: what ticks a lockstep session that an Effect program runs.
 *
 * A ticker calls back on every tick until it is stopped: a timer, a dedicated worker's timer
 * (which a hidden tab doesn't throttle), animation frames, or all of those. It is a host's
 * callback, the bridge a scoped session's `run` waits on with one `Effect.callback`, and a type a
 * game writes as a function, so it is no data type. Plain on purpose (ADR-0024): a tick runs the
 * session inside the call that ticks it, so a ticker that draws can tick and then draw in one
 * frame.
 *
 * @since 0.7.0
 */

/**
 * Calls `onTick` on every tick until the returned function stops it.
 *
 * **When to use**
 *
 * Hand one to a scoped lockstep session's `run`, or provide one as a Co-op client's
 * `CoopTicker` (`arcadekit/net/browser`). In the browser, time it in a dedicated worker: a
 * hidden tab throttles the main thread's timers to about once a second. A test ticks by hand
 * with `arcadekit/net/testing`'s `ManualTicker`.
 *
 * **Details**
 *
 * `onTick` ticks the session before it returns, so a ticker may read the session right after
 * calling it, or tick before it draws. A ticker calls `onTick` from a host callback (a timer, a
 * worker's message, a frame), never from inside `onTick`, and stops calling once stopped.
 *
 * **Example** (A ticker on the page's timer)
 *
 * ```ts
 * import type { Ticker } from "arcadekit/net";
 *
 * const every4ms: Ticker.Ticker = (onTick) => {
 *   const timer = setInterval(onTick, 4);
 *   return () => clearInterval(timer);
 * };
 * const stop = every4ms(() => {});
 * stop();
 * typeof stop; // => "function"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type Ticker = (onTick: () => void) => () => void;
