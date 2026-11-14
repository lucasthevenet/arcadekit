import { Effect } from "effect";
import type { Scope } from "effect";

import type * as Ticker from "../../ticker";

// What ticks a co-op run's lockstep session in the browser: `CoopTicker`'s default.
//
// A co-op run must keep stepping while its tab is hidden (#25, ADR-0012). Browsers throttle a
// hidden tab's main-thread timers to about once a second (an open data channel spares the page
// Chrome's harsher intensive throttling) and stop `requestAnimationFrame`, so a lockstep session
// ticked by them falls behind and stalls everyone. A dedicated worker's timers aren't throttled
// that way, and the messages it posts reach the main thread at its rate, so the run's ticker
// runs its timer in one.
//
// The ticker is plain on purpose (ADR-0024): it is the host's callback a scoped session's `run`
// waits on, as a frame source is an engine's, and its `onTick` runs the session inside the
// worker's message. The worker's lifecycle is Effect: the run's scope terminates it.

/** The part of a dedicated `Worker` the ticker uses. */
export interface TickWorker {
  readonly addEventListener: (
    type: "message" | "error",
    listener: () => void
  ) => void;
  readonly postMessage: (message: number) => void;
  readonly terminate: () => void;
}

export interface WorkerTickerOptions {
  readonly everyMs: number;
  /**
   * The worker that times the ticks, owned by the scope, or undefined where there is none.
   * Defaults to `tickWorker`; tests pass a fake (`Effect.succeed(fake)`) or
   * `Effect.succeed(undefined)`.
   */
  readonly worker?: Effect.Effect<TickWorker | undefined, never, Scope.Scope>;
}

/**
 * The worker's whole program: it ticks every `everyMs` it is sent. Inline, so the worker needs
 * no file of its own from the build.
 */
export const TICK_WORKER_SOURCE =
  "self.onmessage = (event) => { setInterval(() => self.postMessage(0), event.data); };";

/** Makes the worker and the Blob URL of its program, or nothing where no worker starts. */
const startTickWorker = ():
  | { readonly worker: TickWorker; readonly url: string }
  | undefined => {
  if (typeof Worker === "undefined" || typeof Blob === "undefined") {
    return undefined;
  }
  let url: string | undefined;
  try {
    url = URL.createObjectURL(
      new Blob([TICK_WORKER_SOURCE], { type: "text/javascript" })
    );
    return { worker: new Worker(url), url };
  } catch {
    // The page may not start workers (a content security policy, say).
    if (url !== undefined) {
      URL.revokeObjectURL(url);
    }
    return undefined;
  }
};

/**
 * A dedicated worker running `TICK_WORKER_SOURCE`, or undefined where none starts (Node, or a
 * page that may not start workers). The scope terminates it and revokes its Blob URL, whether it
 * ticked, failed, or never got to tick.
 */
export const tickWorker: Effect.Effect<
  TickWorker | undefined,
  never,
  Scope.Scope
> = Effect.acquireRelease(Effect.sync(startTickWorker), (started) =>
  Effect.sync(() => {
    if (started !== undefined) {
      started.worker.terminate();
      URL.revokeObjectURL(started.url);
    }
  })
).pipe(Effect.map((started) => started?.worker));

/**
 * A ticker timed by a worker the scope owns, falling back to the main thread's `setInterval`
 * where no worker starts, or once it fails. Only the timer is in the worker: `onTick` runs on
 * the main thread, with the session and WebRTC. It times one run: its stop ends the worker too.
 */
export const workerTicker = ({
  everyMs,
  worker = tickWorker,
}: WorkerTickerOptions): Effect.Effect<Ticker.Ticker, never, Scope.Scope> =>
  worker.pipe(
    Effect.map((made): Ticker.Ticker => (onTick) => {
      let interval: ReturnType<typeof setInterval> | null = null;
      let stopped = false;
      const onMainThread = () => {
        if (!stopped && interval === null) {
          interval = setInterval(onTick, everyMs);
        }
      };
      if (made === undefined) {
        onMainThread();
      } else {
        made.addEventListener("message", () => {
          if (!stopped) {
            onTick();
          }
        });
        made.addEventListener("error", () => {
          made.terminate();
          onMainThread();
        });
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker's postMessage takes no origin.
        made.postMessage(everyMs);
      }
      return () => {
        stopped = true;
        made?.terminate();
        if (interval !== null) {
          clearInterval(interval);
          interval = null;
        }
      };
    })
  );
