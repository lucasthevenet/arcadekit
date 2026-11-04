import type { World } from "./world";

// Test support, not exported from the root entry: a digest of a run's whole simulation state, so
// the replay, determinism and lockstep tests notice a change in any bit of it.

/** FNV-1a over numbers' float64 bits, so any change in any digit shows. */
export const hasher = () => {
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

/**
 * Passes every number the state hash covers to `add`, in one fixed order: the clock, kills, the
 * player, the weapon slots and every live entity in the pools. One visitor serves every hash, so
 * they can't drift apart.
 */
export const visitWorld = (world: World, add: (value: number) => void) => {
  add(world.time);
  add(world.kills);
  const p = world.player;
  add(p.x);
  add(p.z);
  add(p.hp);
  add(p.maxHp);
  add(p.level);
  add(p.xp);
  add(p.xpNext);
  add(p.faceX);
  add(p.faceZ);
  add(p.hurtTimer);
  for (const slot of world.weapons) {
    add(slot.level);
    add(slot.timer);
  }
  for (const pool of [world.enemies, world.projectiles, world.gems]) {
    add(pool.count);
    for (const array of Object.values(pool.fields)) {
      for (let i = 0; i < pool.count; i++) {
        add(array[i]!);
      }
    }
  }
};

/** Hashes everything `visitWorld` visits. */
export const hashWorld = (world: World): number => {
  const h = hasher();
  visitWorld(world, h.add);
  return h.value;
};
