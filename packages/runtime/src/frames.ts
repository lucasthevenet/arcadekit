/**
 * Where `GameDriver` gets its frames and their times: its own frame clock. It times the driver's
 * frames, which step by real time and then draw. It is not where stepping adapters plug in; a test, a replay or a lockstep runner calls `GameLoop.frame`
 * instead, so it can step without drawing.
 */
export interface FrameSource {
  /** Now, in ms, on the same timeline as the times `request` passes its callbacks. */
  readonly now: () => number;
  /** Calls `callback` once, at the next frame, with that frame's time in ms. Returns a function that cancels it. */
  readonly request: (callback: (nowMs: number) => void) => () => void;
}

/** Frames from requestAnimationFrame, timed by performance.now: the browser's display refresh. */
export const animationFrames: FrameSource = {
  now: () => performance.now(),
  request: (callback) => {
    const handle = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(handle);
  },
};
