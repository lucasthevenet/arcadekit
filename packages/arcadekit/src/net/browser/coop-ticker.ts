/**
 * Co-op tickers: what ticks a Co-op client's lockstep run, every few milliseconds.
 *
 * A co-op run must keep stepping while its tab is hidden (#25, ADR-0012). Browsers throttle a
 * hidden tab's main-thread timers to about once a second and stop animation frames, so a run
 * ticked by them falls behind and stalls everyone. A dedicated worker's timers aren't throttled
 * that way, so the default ticker times its ticks in one, and ticks on the main thread, with the
 * session and WebRTC. It is a reference, whose default suits every browser app: a test provides
 * `arcadekit/net/testing`'s `ManualTicker` in its place.
 *
 * @since 0.7.0
 */
import { Context } from "effect";
import type { Effect, Scope } from "effect";

import type * as Ticker from "../ticker";
import { workerTicker } from "./internal/worker-ticker";

/** How often a run ticks on the default ticker. Browsers clamp shorter timers to about 4 ms anyway. */
const TICK_MS = 4;

/**
 * What ticks a co-op run: an Effect that makes a ticker, run when a run starts, in the run's
 * scope, so the ticker stops with the run.
 *
 * **When to use**
 *
 * Nowhere in an app: its default is a timer in a dedicated worker, which a hidden tab doesn't
 * throttle, falling back to the page's timer where no worker starts. A test provides
 * `ManualTicker.layer(ticker)` (`arcadekit/net/testing`), to tick by hand.
 *
 * **Details**
 *
 * The default ticks every 4 ms. Its worker is made with each run and terminated when the run's
 * scope closes, its script's Blob URL revoked with it. The Co-op client also ticks a run on each
 * animation frame while attached, before drawing.
 *
 * **Example** (A ticker of the test's own)
 *
 * ```ts
 * import { CoopTicker } from "arcadekit/net/browser";
 * import type { Ticker } from "arcadekit/net";
 * import { Effect, Layer } from "effect";
 *
 * const never: Ticker.Ticker = () => () => {};
 * const program = Effect.gen(function* () {
 *   return (yield* yield* CoopTicker.CoopTicker) === never;
 * });
 * const provided = Layer.succeed(CoopTicker.CoopTicker, Effect.succeed(never));
 * Effect.runSync(program.pipe(Effect.scoped, Effect.provide(provided))); // => true
 * ```
 *
 * @category references
 * @since 0.7.0
 */
export const CoopTicker: Context.Reference<
  Effect.Effect<Ticker.Ticker, never, Scope.Scope>
> = Context.Reference("arcadekit/net/browser/CoopTicker", {
  defaultValue: () => workerTicker({ everyMs: TICK_MS }),
});
