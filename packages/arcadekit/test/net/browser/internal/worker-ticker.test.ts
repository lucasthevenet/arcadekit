import { Effect, Exit, Scope } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TICK_WORKER_SOURCE,
  tickWorker,
  workerTicker,
} from "../../../../src/net/browser/internal/worker-ticker";
import type {
  TickWorker,
  WorkerTickerOptions,
} from "../../../../src/net/browser/internal/worker-ticker";
import type { Ticker } from "../../../../src/net/index";

// The ticker against a fake worker and fake timers. That a real worker's timer keeps its rate in
// a hidden tab is the browser's part; the co-op end-to-end test checks it in Chromium.

const fakeWorker = () => {
  const listeners = {
    message: [] as (() => void)[],
    error: [] as (() => void)[],
  };
  const sent: number[] = [];
  const state = { terminated: false };
  const worker: TickWorker = {
    addEventListener: (type, listener) => listeners[type].push(listener),
    postMessage: (message) => sent.push(message),
    terminate: () => {
      state.terminated = true;
    },
  };
  const fire = (type: "message" | "error") => {
    for (const listener of listeners[type]) {
      listener();
    }
  };
  return {
    worker,
    sent,
    terminated: () => state.terminated,
    /** The worker's timer fired. */
    tick: () => fire("message"),
    fail: () => fire("error"),
  };
};

/** Runs `effect` in a scope the test closes with `close`. */
const inScope = <A>(effect: Effect.Effect<A, never, Scope.Scope>) => {
  const scope = Effect.runSync(Scope.make());
  const value = Effect.runSync(Scope.provide(effect, scope));
  return {
    value,
    close: () => Effect.runSync(Scope.close(scope, Exit.void)),
  };
};

const ticker = (options: WorkerTickerOptions): Ticker.Ticker =>
  inScope(workerTicker(options)).value;

describe(workerTicker, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks on each of the worker's messages, and on no main-thread timer", () => {
    const fake = fakeWorker();
    const onTick = vi.fn<() => void>();
    ticker({ everyMs: 4, worker: Effect.succeed(fake.worker) })(onTick);
    expect(fake.sent).toStrictEqual([4]);
    vi.advanceTimersByTime(1000);
    expect(onTick).not.toHaveBeenCalled();
    fake.tick();
    fake.tick();
    fake.tick();
    expect(onTick).toHaveBeenCalledTimes(3);
  });

  it("stops the worker, and ignores a message already on its way", () => {
    const fake = fakeWorker();
    const onTick = vi.fn<() => void>();
    const stop = ticker({ everyMs: 4, worker: Effect.succeed(fake.worker) })(
      onTick
    );
    fake.tick();
    stop();
    fake.tick();
    expect([onTick.mock.calls.length, fake.terminated()]).toStrictEqual([
      1,
      true,
    ]);
  });

  it("ticks on the main thread's timer where no worker starts", () => {
    const onTick = vi.fn<() => void>();
    const stop = ticker({ everyMs: 4, worker: Effect.succeed(undefined) })(
      onTick
    );
    vi.advanceTimersByTime(40);
    expect(onTick).toHaveBeenCalledTimes(10);
    stop();
    vi.advanceTimersByTime(40);
    expect(onTick).toHaveBeenCalledTimes(10);
  });

  it("falls back to the main thread's timer when the worker fails", () => {
    const fake = fakeWorker();
    const onTick = vi.fn<() => void>();
    const stop = ticker({ everyMs: 4, worker: Effect.succeed(fake.worker) })(
      onTick
    );
    fake.fail();
    expect(fake.terminated()).toBe(true);
    vi.advanceTimersByTime(40);
    expect(onTick).toHaveBeenCalledTimes(10);
    stop();
    vi.advanceTimersByTime(40);
    expect(onTick).toHaveBeenCalledTimes(10);
  });

  it("falls back in Node, where there is no Worker", () => {
    const onTick = vi.fn<() => void>();
    const stop = ticker({ everyMs: 4 })(onTick);
    vi.advanceTimersByTime(8);
    stop();
    expect(onTick).toHaveBeenCalledTimes(2);
  });

  it("runs a worker program that ticks at the rate it is sent", () => {
    const posted: unknown[] = [];
    const self: {
      onmessage?: (event: { readonly data: number }) => void;
      postMessage: (message: unknown) => void;
    } = { postMessage: (message) => posted.push(message) };
    // The worker's program, run as a worker would, with its own `self`.
    // oxlint-disable-next-line eslint/no-new-func
    const program = new Function("self", "setInterval", TICK_WORKER_SOURCE);
    program(self, setInterval);
    self.onmessage?.({ data: 5 });
    vi.advanceTimersByTime(50);
    expect(posted).toHaveLength(10);
  });
});

/** A stand-in for the browser's Worker: each one made is kept in `made`. */
class StubWorker implements TickWorker {
  static made: StubWorker[] = [];
  static refuse = false;
  terminated = false;
  private readonly errorListeners: (() => void)[] = [];

  constructor() {
    if (StubWorker.refuse) {
      throw new Error("workers aren't allowed");
    }
    StubWorker.made.push(this);
  }

  addEventListener(type: "message" | "error", listener: () => void) {
    if (type === "error") {
      this.errorListeners.push(listener);
    }
  }

  // oxlint-disable-next-line class-methods-use-this -- the stub ignores what it is sent.
  postMessage() {}

  terminate() {
    this.terminated = true;
  }

  /** The worker failed, as one that can't load its script does. */
  fail() {
    for (const listener of this.errorListeners) {
      listener();
    }
  }
}

/** A browser's Worker, Blob and object URLs, stubbed: what `tickWorker` makes and frees. */
const stubWorkers = (options: { readonly refuse?: boolean } = {}) => {
  const urls = { made: 0, revoked: 0 };
  StubWorker.made = [];
  StubWorker.refuse = options.refuse === true;
  // A Blob nothing reads: only the stubbed URL sees it.
  vi.stubGlobal("Blob", vi.fn());
  vi.stubGlobal("URL", {
    createObjectURL: () => {
      urls.made += 1;
      return "blob:tick";
    },
    revokeObjectURL: () => {
      urls.revoked += 1;
    },
  });
  vi.stubGlobal("Worker", StubWorker);
  return { urls, workers: StubWorker.made };
};

describe("the tick worker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("terminates the worker and revokes its URL when the scope closes before the first tick", () => {
    const { urls, workers } = stubWorkers();
    const { value, close } = inScope(
      workerTicker({ everyMs: 4, worker: tickWorker })
    );
    value(() => {});
    close();
    expect([urls, workers.map((worker) => worker.terminated)]).toStrictEqual([
      { made: 1, revoked: 1 },
      [true],
    ]);
  });

  it("revokes the URL of a worker that failed before it ticked", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { urls, workers } = stubWorkers();
    const { value, close } = inScope(workerTicker({ everyMs: 4 }));
    const stop = value(() => {});
    workers[0]!.fail();
    stop();
    close();
    vi.useRealTimers();
    expect([urls, workers[0]!.terminated]).toStrictEqual([
      { made: 1, revoked: 1 },
      true,
    ]);
  });

  it("frees the worker even if no ticker ever ran on it", () => {
    const { urls, workers } = stubWorkers();
    const { value, close } = inScope(tickWorker);
    const made = value !== undefined;
    close();
    expect([made, urls, workers[0]!.terminated]).toStrictEqual([
      true,
      { made: 1, revoked: 1 },
      true,
    ]);
  });

  it("is nothing, with its URL revoked, where the page may not start workers", () => {
    const { urls } = stubWorkers({ refuse: true });
    const { value, close } = inScope(tickWorker);
    close();
    expect([value, urls]).toStrictEqual([undefined, { made: 1, revoked: 1 }]);
  });
});
