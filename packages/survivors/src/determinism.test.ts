import { describe, expect, it } from "vitest";

import { LONG_RUN_RECORDED, LONG_RUN_SEEDS, longRun } from "./long-run";

// Long-run determinism in Node: the long run in long-run.ts (20,000 steps of a full horde under
// analog input, through GameLoop) must give the recorded hashes. `pnpm test:browsers` plays the
// same long run in Chromium, Firefox and WebKit against the same recorded hashes.

describe("survivors long-run determinism", () => {
  it.each(LONG_RUN_SEEDS)("gives the recorded hashes for seed %i", (seed) => {
    const run = longRun(seed);
    // The run must stay busy to the end, or the hashes prove little.
    expect(run.status).toBe("running");
    expect(run.kills).toBeGreaterThan(1500);
    expect(run.level).toBeGreaterThan(10);
    // If they change, the simulation's arithmetic changed: lockstep peers on the old code would
    // desync. Re-record (in long-run.ts) only for a deliberate rule change.
    expect([run.final, run.trace]).toStrictEqual(LONG_RUN_RECORDED[seed]);
  });
});
