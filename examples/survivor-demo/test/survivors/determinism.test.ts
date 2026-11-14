import { describe, expect, it } from "vitest";

import * as LongRun from "../../src/survivors/internal/long-run";

// Long-run determinism in Node: the long run in long-run.ts (20,000 steps of a full horde under
// analog input, stepped by `Game.Loop`) must give the recorded hashes. `pnpm test:browsers` plays
// the same long run in Chromium, Firefox and WebKit against the same recorded hashes.

// A seed takes a second or two, and several times that on a loaded machine: past vitest's 5 s.
const TIMEOUT_MS = 30_000;

describe("survivors long-run determinism", () => {
  it.each(LongRun.seeds)(
    "gives the recorded hashes for seed %i",
    { timeout: TIMEOUT_MS },
    (seed) => {
      const run = LongRun.play(seed);
      // The run must stay busy to the end, or the hashes prove little.
      expect(run.status).toBe("running");
      expect(run.kills).toBeGreaterThan(1500);
      expect(run.level).toBeGreaterThan(10);
      // If they change, the simulation's arithmetic changed: lockstep peers on the old code would
      // desync. Re-record (in long-run.ts) only for a deliberate rule change.
      expect([run.final, run.trace]).toStrictEqual(LongRun.recorded[seed]);
    }
  );
});
