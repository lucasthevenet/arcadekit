import { GameLoop } from "@gamekit/runtime";
import type { StepInput } from "@gamekit/runtime";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { hashWorld, visitWorld } from "./hash-world";
import {
  GameContent,
  chooseUpgrade,
  soloInput,
  survivorsSimulation,
} from "./index";
import type { HeroInput, World } from "./index";

// Long-run determinism: 20,000 steps (5.5 minutes) of a full horde under analog input, through
// the GameLoop the demos run. The pinned replay is too short to catch a change in the last bits
// of the simulation's arithmetic: on the engines measured in
// docs/research/cross-engine-determinism.md, approximated Math made runs like these split after
// 330 steps while the replay still matched. The step uses only exact operations (ADR-0011), so
// every conforming engine must give these hashes; any change to the simulation's arithmetic
// changes them.

const STEPS = 20_000;
// Three seeds keep the file near 3 s in CI; each one is about a second.
const SEEDS = [1, 1234, 2026] as const;

// An unkillable hero and waves for the whole run, so every step has a full horde, projectiles,
// gems and regular level-ups.
const content = Schema.decodeUnknownSync(GameContent)({
  rules: {
    arenaHalfSize: 30,
    maxEnemies: 200,
    xpToLevel2: 3,
    xpGrowth: 1.3,
    baseMoveSpeedScale: 1,
    basePickupRadius: 2.5,
    choicesPerLevelUp: 3,
    runLength: 400,
  },
  heroes: [
    {
      id: "bolter",
      name: "Bolter",
      description: "",
      color: "#ffffff",
      maxHp: 1e9,
      moveSpeed: 6,
      startingWeapon: "bolt",
    },
  ],
  enemies: [
    {
      id: "grunt",
      name: "Grunt",
      color: "#00ff00",
      hp: 8,
      speed: 2.5,
      damage: 10,
      radius: 0.45,
      xp: 1,
    },
  ],
  weapons: [
    {
      id: "bolt",
      name: "Bolt",
      description: "",
      color: "#ffff00",
      damage: 10,
      damagePerLevel: 3,
      cooldown: 0.5,
      cooldownScalePerLevel: 0.9,
      maxLevel: 5,
      behavior: {
        kind: "bolt",
        projectileSpeed: 20,
        count: 1,
        countPerLevel: 0.5,
        pierce: 1,
        range: 14,
      },
    },
    {
      id: "aura",
      name: "Aura",
      description: "",
      color: "#ff8800",
      damage: 6,
      damagePerLevel: 2,
      cooldown: 0.5,
      cooldownScalePerLevel: 0.95,
      maxLevel: 5,
      behavior: { kind: "aura", radius: 2.6, radiusPerLevel: 0.3 },
    },
  ],
  passives: [
    {
      id: "power",
      name: "Power",
      description: "",
      stat: "damage",
      amountPerLevel: 0.1,
      maxLevel: 3,
    },
  ],
  waves: [{ from: 0, to: 400, enemy: "grunt", perSecond: 6 }],
});

/** One of 65,536 evenly spaced values in [-1, 1]. */
const axis = (bits: number): number => (bits - 32_767.5) / 32_767.5;

/**
 * An analog stick that moves to a new position every 30 steps, picked by an integer hash of the
 * step number (no Math.random, so every engine reads the same input). The length can pass 1, so
 * the simulation's own normalisation runs too.
 */
const wander = (): StepInput<HeroInput> => {
  const input = { moveX: 0, moveZ: 0 };
  return {
    read: (step) => {
      let h =
        Math.imul(
          (Math.floor(step / 30) + 1) ^ 0x9e_37_79_b9,
          0x85_eb_ca_6b
        ) >>> 0;
      h = Math.imul(h ^ (h >>> 13), 0xc2_b2_ae_35) >>> 0;
      input.moveX = axis(h & 0xff_ff);
      input.moveZ = axis(h >>> 16);
      return input;
    },
  };
};

const FNV_PRIME = 0x01_00_01_93;
const bits = new Float64Array(1);
const words = new Uint32Array(bits.buffer);

/** Folds a number's float64 bits into an FNV-style hash, a 32-bit word at a time. */
const mix = (hash: number, value: number): number => {
  bits[0] = value;
  const low = Math.imul(hash ^ words[0]!, FNV_PRIME) >>> 0;
  return Math.imul(low ^ words[1]!, FNV_PRIME) >>> 0;
};

/**
 * The same state as `hashWorld`, folded into `hash` a word at a time rather than a byte:
 * several times faster, which keeps a hash after every one of 20,000 steps affordable.
 */
const mixWorld = (hash: number, world: World): number => {
  let h = hash;
  visitWorld(world, (value) => {
    h = mix(h, value);
  });
  return h;
};

/**
 * Plays STEPS steps, one per frame at 60 frames a second, taking the second upgrade when offered.
 * Returns the final state's `hashWorld` and a trace that folds in the whole state after every
 * step, so a divergence that later evens out still shows.
 */
const longRun = (seed: number) => {
  const loop = new GameLoop(survivorsSimulation);
  const input = soloInput(wander());
  loop.start({ content, heroIds: ["bolter"] }, seed, 0);
  const world = loop.state!;
  let trace = 0x81_1c_9d_c5;
  for (let i = 0; i < STEPS; i++) {
    const nowMs = (i * 1000) / 60;
    const { offer } = world.heroes[0]!;
    if (offer) {
      loop.modify(
        (offered) => chooseUpgrade(offered, 0, Math.min(1, offer.length - 1)),
        nowMs
      );
    }
    loop.frame(input, { steps: 1 }, nowMs);
    trace = mixWorld(trace, world);
  }
  return {
    status: world.status,
    kills: world.kills,
    level: world.level,
    final: hashWorld(world),
    trace,
  };
};

describe("survivors long-run determinism", () => {
  it.each(SEEDS)("gives the recorded hashes for seed %i", (seed) => {
    const run = longRun(seed);
    // The run must stay busy to the end, or the hashes prove little.
    expect(run.status).toBe("running");
    expect(run.kills).toBeGreaterThan(1500);
    expect(run.level).toBeGreaterThan(10);
    // Recorded from this code. If they change, the simulation's arithmetic changed: lockstep
    // peers on the old code would desync. Re-record only for a deliberate rule change.
    expect([run.final, run.trace]).toStrictEqual(RECORDED[seed]);
  });
});

const RECORDED: Record<(typeof SEEDS)[number], readonly [number, number]> = {
  1: [2_342_704_773, 3_790_048_561],
  1234: [3_674_069_050, 3_202_377_843],
  2026: [3_483_031_454, 257_317_921],
};
