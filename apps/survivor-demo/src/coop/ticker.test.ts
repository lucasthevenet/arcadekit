import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TICK_WORKER_SOURCE, workerTicker } from "./ticker";
import type { TickWorker } from "./ticker";

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
    workerTicker({ everyMs: 4, createWorker: () => fake.worker })(onTick);
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
    const stop = workerTicker({ everyMs: 4, createWorker: () => fake.worker })(
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
    const stop = workerTicker({ everyMs: 4, createWorker: () => {} })(onTick);
    vi.advanceTimersByTime(40);
    expect(onTick).toHaveBeenCalledTimes(10);
    stop();
    vi.advanceTimersByTime(40);
    expect(onTick).toHaveBeenCalledTimes(10);
  });

  it("falls back to the main thread's timer when the worker fails", () => {
    const fake = fakeWorker();
    const onTick = vi.fn<() => void>();
    const stop = workerTicker({ everyMs: 4, createWorker: () => fake.worker })(
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
    const stop = workerTicker({ everyMs: 4 })(onTick);
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
