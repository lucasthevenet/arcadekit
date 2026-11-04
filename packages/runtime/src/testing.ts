// Test helpers for code that runs a game in the browser. Only tests import this entry: it is not
// part of the runtime's API.

import type { FrameSource } from "./frames";

/**
 * A FrameSource a test drives: no frame runs until the test runs it, at a time it chooses.
 * `now` starts at 0. Pass it to `makeGameEngine(definition, { frames })` or `new GameDriver`.
 */
export const manualFrames = (): FrameSource & {
  /** Whether a frame was requested and has not run or been cancelled. */
  readonly waiting: () => boolean;
  /** Moves `now` to `nowMs`, then runs the requested frame, if any, at that time. */
  readonly runFrameAt: (nowMs: number) => void;
} => {
  let now = 0;
  let pending: ((nowMs: number) => void) | null = null;
  return {
    now: () => now,
    request: (callback) => {
      pending = callback;
      return () => {
        if (pending === callback) {
          pending = null;
        }
      };
    },
    waiting: () => pending !== null,
    runFrameAt: (nowMs) => {
      now = nowMs;
      const callback = pending;
      pending = null;
      callback?.(nowMs);
    },
  };
};
