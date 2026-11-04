/**
 * Calls `onTick` about every `everyMs` until the returned function stops it.
 *
 * A co-op run must keep stepping while its tab is hidden (#25, ADR-0012). Browsers throttle a
 * hidden tab's main-thread timers to about once a second (Chrome throttles them harder after
 * minutes) and stop `requestAnimationFrame`, so a lockstep session ticked by them falls behind
 * and stalls everyone. A dedicated worker's timers aren't throttled that way, and the messages
 * it posts reach the main thread at its rate, so the default ticker runs its timer in one.
 */
export type Ticker = (onTick: () => void) => () => void;

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
   * Makes the worker that times the ticks, or returns undefined where there is none (Node, or a
   * page that may not start workers). Defaults to a worker from `TICK_WORKER_SOURCE`.
   */
  readonly createWorker?: () => TickWorker | undefined;
}

/**
 * The worker's whole program: it ticks every `everyMs` it is sent. Inline, so the worker needs
 * no file of its own from the build.
 */
export const TICK_WORKER_SOURCE =
  "self.onmessage = (event) => { setInterval(() => self.postMessage(0), event.data); };";

const createTickWorker = (): TickWorker | undefined => {
  if (typeof Worker === "undefined" || typeof Blob === "undefined") {
    return undefined;
  }
  const url = URL.createObjectURL(
    new Blob([TICK_WORKER_SOURCE], { type: "text/javascript" })
  );
  try {
    const worker = new Worker(url);
    // The worker has its own copy of the script once it runs; the URL can go then.
    worker.addEventListener("message", () => URL.revokeObjectURL(url), {
      once: true,
    });
    return worker;
  } catch {
    URL.revokeObjectURL(url);
    return undefined;
  }
};

/**
 * A ticker timed by a dedicated worker, falling back to the main thread's `setInterval` where
 * no worker starts, or if it fails. Only the timer is in the worker: `onTick` runs on the main
 * thread, with the session and WebRTC.
 */
export const workerTicker =
  ({ everyMs, createWorker = createTickWorker }: WorkerTickerOptions): Ticker =>
  (onTick) => {
    let interval: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    const onMainThread = () => {
      if (!stopped && interval === null) {
        interval = setInterval(onTick, everyMs);
      }
    };
    const worker = createWorker();
    if (worker === undefined) {
      onMainThread();
    } else {
      worker.addEventListener("message", () => {
        if (!stopped) {
          onTick();
        }
      });
      worker.addEventListener("error", () => {
        worker.terminate();
        onMainThread();
      });
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker's postMessage takes no origin.
      worker.postMessage(everyMs);
    }
    return () => {
      stopped = true;
      worker?.terminate();
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    };
  };
