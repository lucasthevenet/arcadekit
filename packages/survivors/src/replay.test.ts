import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { GameContent, chooseUpgrade, createWorld, step } from "./index";
import type { World } from "./index";

// Replay check: the same seed and the same input script must give the same run, bit for bit.
// It guards kit changes (runtime, core, input) against changing survivors' behavior.

const content = Schema.decodeUnknownSync(GameContent)({
  rules: {
    arenaHalfSize: 30,
    maxEnemies: 200,
    xpToLevel2: 3,
    xpGrowth: 1.3,
    baseMoveSpeedScale: 1,
    basePickupRadius: 2.5,
    choicesPerLevelUp: 3,
    runLength: 90,
  },
  heroes: [
    {
      id: "bolter",
      name: "Bolter",
      description: "",
      color: "#ffffff",
      maxHp: 400,
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
  waves: [{ from: 0, to: 90, enemy: "grunt", perSecond: 4 }],
});

/** FNV-1a over numbers' float64 bits, so any change in any digit shows. */
const hasher = () => {
  let hash = 0x81_1c_9d_c5;
  const bits = new Float64Array(1);
  const bytes = new Uint8Array(bits.buffer);
  return {
    add: (value: number) => {
      bits[0] = value;
      for (const byte of bytes) {
        hash = Math.imul(hash ^ byte, 0x01_00_01_93) >>> 0;
      }
    },
    get value() {
      return hash;
    },
  };
};

const hashWorld = (world: World): number => {
  const h = hasher();
  h.add(world.time);
  h.add(world.kills);
  for (const value of Object.values(world.player)) {
    h.add(value);
  }
  for (const slot of world.weapons) {
    h.add(slot.level);
    h.add(slot.timer);
  }
  for (const pool of [world.enemies, world.projectiles, world.gems]) {
    h.add(pool.count);
    for (const array of Object.values(pool.fields)) {
      for (let i = 0; i < pool.count; i++) {
        h.add(array[i]!);
      }
    }
  }
  return h.value;
};

/** Plays a fixed input script: zig-zag movement, the second upgrade when offered. */
const replay = (seed: number, steps: number) => {
  const world = createWorld({ content, heroId: "bolter" }, seed);
  let events = 0;
  for (let i = 0; i < steps && world.status === "running"; i++) {
    if (world.offer) {
      chooseUpgrade(world, Math.min(1, world.offer.length - 1));
    }
    const leg = Math.floor(i / 90) % 4;
    step(
      world,
      { moveX: leg === 0 ? 1 : leg === 2 ? -1 : 0.3, moveZ: leg % 2 },
      1 / 60
    );
    events += world.events.drain().length;
  }
  return { world, events };
};

describe("survivors replay", () => {
  it("gives an identical state hash for the same seed and input script", () => {
    const a = replay(1234, 60 * 60);
    const b = replay(1234, 60 * 60);
    // The script must exercise the run, or the hash proves little.
    expect(a.world.kills).toBeGreaterThan(20);
    expect(a.world.player.level).toBeGreaterThan(2);
    expect(hashWorld(a.world)).toBe(hashWorld(b.world));
    expect(a.events).toBe(b.events);
    // Recorded before any kit change for push-puzzle. If this changes, survivors plays differently.
    expect(hashWorld(a.world)).toBe(1_294_328_663);
  });

  it("gives a different hash for a different seed", () => {
    expect(hashWorld(replay(1234, 600).world)).not.toBe(
      hashWorld(replay(4321, 600).world)
    );
  });
});
