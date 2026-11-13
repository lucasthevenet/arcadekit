import { StateHasher, visitPool } from "arcadekit/core";

import type { World } from "./world";

// A digest of a run's whole simulation state, so the replay, determinism and lockstep tests
// notice a change in any bit of it, and a lockstep session's desync check does too: `hashWorld`
// is the root entry's `hash` for `arcadekit/net`. The list of what it covers is this file's;
// the fold and the walk over a pool are the kit's (`StateHasher`, `visitPool`).

/** One hasher for every hash: `hashWorld` resets it first. */
const hasher = new StateHasher();

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
  visitPool(world.enemies, add);
  visitPool(world.projectiles, add);
  visitPool(world.gems, add);
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
  hasher.reset();
  visitWorld(world, hasher.number);
  return hasher.digest();
};
