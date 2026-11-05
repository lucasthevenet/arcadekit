import { longRun } from "../src/long-run";

// The page's script: the long-run scenario and survivors' simulation, bundled into one classic
// script that exposes `arcadekitLongRun.run(seed)`. The runner calls it in each browser.

/** Plays one long run and returns its hashes as plain data, for Playwright to send back. */
export const run = (seed: number) => {
  const started = performance.now();
  const result = longRun(seed);
  return {
    status: result.status,
    kills: result.kills,
    level: result.level,
    final: result.final,
    trace: result.trace,
    traces: [...result.traces],
    ms: performance.now() - started,
  };
};
