import type { World } from "./world";

// Test support, not exported from the root entry: a digest of a run's whole simulation state, so
// the replay and determinism tests notice a change in any bit of it.

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

/** Hashes the clock, kills, the player, the weapon slots and every live entity in the pools. */
export const hashWorld = (world: World): number => {
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
