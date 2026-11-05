import type { World } from "./world";

// A digest of a run's whole simulation state, so the replay, determinism and lockstep tests
// notice a change in any bit of it, and a lockstep session's desync check does too: `hashWorld`
// is the root entry's `hash` for `@arcadekit/net`.

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

const STATUS_CODE = { playing: 0, down: 1, left: 2 } as const;

/**
 * Passes every number the state hash covers to `add`, in one fixed order: the clock, kills, the
 * first hero with the team's level and XP, its weapon slots and every live entity in the pools.
 * A run with more than one hero adds the offer state, the spawn cursor and the other heroes after
 * that, so a one-hero run hashes exactly what the single-player game always has, and its pinned
 * hashes hold. One visitor serves every hash, so they can't drift apart.
 */
export const visitWorld = (world: World, add: (value: number) => void) => {
  add(world.time);
  add(world.kills);
  const first = world.heroes[0]!;
  add(first.x);
  add(first.z);
  add(first.hp);
  add(first.maxHp);
  add(world.level);
  add(world.xp);
  add(world.xpNext);
  add(first.faceX);
  add(first.faceZ);
  add(first.hurtTimer);
  for (const slot of first.weapons) {
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
  if (world.heroes.length === 1) {
    return;
  }
  add(world.offerSeq);
  add(world.pendingLevelUps);
  add(world.spawnCursor);
  for (const hero of world.heroes) {
    add(STATUS_CODE[hero.status]);
    add(hero.offer === null ? 0 : 1);
    add(hero.paused ? 1 : 0);
    if (hero.slot === 0) {
      continue;
    }
    add(hero.x);
    add(hero.z);
    add(hero.hp);
    add(hero.maxHp);
    add(hero.faceX);
    add(hero.faceZ);
    add(hero.hurtTimer);
    add(hero.weapons.length);
    for (const slot of hero.weapons) {
      add(slot.level);
      add(slot.timer);
    }
  }
};

/** Hashes everything `visitWorld` visits. The cue counters (`World.cues`) aren't visited: they only drive sound (ADR-0014). */
export const hashWorld = (world: World): number => {
  const h = hasher();
  visitWorld(world, h.add);
  return h.value;
};
