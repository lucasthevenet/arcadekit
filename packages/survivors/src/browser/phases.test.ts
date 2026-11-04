import { createPool } from "@gamekit/core";
import { describe, expect, it } from "vitest";

import { StablePhases } from "./phases";

const LAYOUT = { x: Float32Array, z: Float32Array, kind: Uint16Array };

const spawn = (
  pool: ReturnType<typeof createPool<typeof LAYOUT>>,
  x: number,
  kind = 0
) => {
  const i = pool.add();
  pool.fields.x[i] = x;
  pool.fields.z[i] = 0;
  pool.fields.kind[i] = kind;
};

/** Each entity's phase, by its x (which names it in these tests). */
const byX = (
  pool: ReturnType<typeof createPool<typeof LAYOUT>>,
  phases: StablePhases
) => {
  const out: Record<number, number> = {};
  for (let i = 0; i < pool.count; i++) {
    out[pool.fields.x[i]!] = phases.phase(i);
  }
  return out;
};

describe(StablePhases, () => {
  it("keeps each entity's phase when the pool moves its last entity into a removed one's slot", () => {
    const pool = createPool(8, LAYOUT);
    for (const x of [0, 2, 4, 6, 8]) {
      spawn(pool, x);
    }
    const phases = new StablePhases(8);
    const { x, z, kind } = pool.fields;
    phases.update(pool.count, x, z, kind, 0, 4);
    const before = byX(pool, phases);
    pool.remove(1);
    pool.remove(0);
    phases.update(pool.count, x, z, kind, 1 / 60, 4);
    const after = byX(pool, phases);
    expect(after).toStrictEqual({ 4: before[4], 6: before[6], 8: before[8] });
  });

  it("gives a new entity a phase of its own, and doesn't hand a dead one's to another kind", () => {
    const pool = createPool(8, LAYOUT);
    spawn(pool, 0);
    spawn(pool, 0.1, 1);
    const phases = new StablePhases(8);
    const { x, z, kind } = pool.fields;
    phases.update(pool.count, x, z, kind, 0, 4);
    const first = phases.phase(0);
    pool.remove(0);
    phases.update(pool.count, x, z, kind, 1 / 60, 4);
    // The kind-1 entity, now in slot 0, keeps its own phase, not the dead one's.
    expect(phases.phase(0)).not.toBe(first);
    spawn(pool, 20);
    phases.update(pool.count, x, z, kind, 2 / 60, 4);
    expect(new Set([first, phases.phase(0), phases.phase(1)]).size).toBe(3);
  });
});
