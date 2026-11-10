import { SpatialGrid, clamp, createPool, makeRng } from "arcadekit/core";
import type { Pool, Rng } from "arcadekit/core";
import type * as Game from "arcadekit/game";

import { HeroLeft, LeveledUp, RunEnded } from "./events";
import type { Hud } from "./events";
import {
  MAX_HEROES,
  MAX_WEAPONS,
  applyChoice,
  auraRadius,
  createHero,
  rollUpgrades,
  weaponCooldown,
  weaponDamage,
} from "./hero";
import type { Hero, WeaponSlot } from "./hero";
import type { HeroInput, SurvivorsInput } from "./input";
import { cos, hypot2, powInt, sin } from "./math";
import type { EnemyDef, GameContent } from "./schema";

// The survivors simulation: plain data and plain functions, no Effect, no Three.js, no DOM.
// Crowds live in arcadekit/core pools (one typed array per field), so the per-frame loop
// allocates nothing and the garbage collector never causes a stutter. Only what a step reports
// is allocated: an event is rare.
//
// A run has one hero per player (hero.ts); everything else is shared: the clock, the team's XP
// and level, the horde, projectiles, gems and the Rng. Heroes are visited in slot order
// everywhere, so every lockstep peer computes the same step. With one hero, every rule computes
// exactly what the single-player game always has.

const PLAYER_RADIUS = 0.5;
const MAX_PROJECTILES = 512;
const MAX_GEMS = 1024;
const NEIGHBOR_BUFFER = 256;
const PROJECTILE_REHIT_DELAY = 0.15;
const GEM_PICKUP_DISTANCE = 0.6;
const GEM_MAGNET_SPEED = 18;
const SPAWN_DISTANCE_MIN = 16;
const SPAWN_DISTANCE_MAX = 22;

export interface SurvivorsConfig {
  readonly content: GameContent;
  /** One hero id per player, in player order (the host first in lockstep). 1 to 4. */
  readonly heroIds: readonly string[];
}

type RunStatus = "running" | "won" | "dead";

const ENEMY_LAYOUT = {
  x: Float32Array,
  z: Float32Array,
  hp: Float32Array,
  type: Uint16Array,
  hitFlash: Float32Array,
};
const PROJECTILE_LAYOUT = {
  x: Float32Array,
  z: Float32Array,
  vx: Float32Array,
  vz: Float32Array,
  damage: Float32Array,
  life: Float32Array,
  pierce: Uint8Array,
  rehit: Float32Array,
  /** The firing hero's slot times MAX_WEAPONS, plus the index in its weapons, so the view can color projectiles. */
  weapon: Uint8Array,
};
const GEM_LAYOUT = {
  x: Float32Array,
  z: Float32Array,
  value: Float32Array,
  magnet: Uint8Array,
};

/**
 * Cue counters (ADR-0014): running totals of the moments that make a sound. The step bumps them
 * and never reads them, they only go up during a run, and `hashWorld` leaves them out. A sound
 * view compares them with what it saw last frame and plays a sound for each one that rose.
 * All preallocated by `createWorld`, so bumping one never allocates.
 */
interface SurvivorsCues {
  /** Bolt projectiles fired, one per projectile, by weapon def index (`content.weapons`). The aura fires none. */
  readonly shots: Uint32Array;
  /** Bolt projectiles hitting an enemy. Aura damage isn't counted: the aura hums instead. */
  hits: number;
  /** Enemies killed, by anything. */
  kills: number;
  /** Gems picked up by a hero. */
  pickups: number;
  /** Steps in which a hero took contact damage, by hero slot. */
  readonly hurt: Uint32Array;
  /** Heroes going down, by hero slot. */
  readonly downed: Uint32Array;
  /** Team levels gained. */
  levelUps: number;
  /** 1 once the run is won. */
  won: number;
  /** 1 once the run is lost. */
  lost: number;
}

export interface World {
  readonly content: GameContent;
  readonly rng: Rng;
  time: number;
  kills: number;
  status: RunStatus;
  /** The team's level and XP: any hero's gem feeds them. */
  level: number;
  xp: number;
  xpNext: number;
  /** Level-ups not yet offered and closed. */
  pendingLevelUps: number;
  /** Numbers the offers: bumped each time heroes are offered upgrades, so a pick names the offer it answers. */
  offerSeq: number;
  /** The slot the next enemy spawns around, before skipping heroes that aren't playing. */
  spawnCursor: number;
  /** One per player, by slot. Never removed from, so slots stay stable; a hero that leaves is marked `left`. */
  readonly heroes: readonly Hero[];
  readonly enemyDefs: readonly EnemyDef[];
  readonly enemyTypeById: ReadonlyMap<string, number>;
  readonly enemies: Pool<typeof ENEMY_LAYOUT>;
  readonly projectiles: Pool<typeof PROJECTILE_LAYOUT>;
  readonly gems: Pool<typeof GEM_LAYOUT>;
  readonly spawnBudget: Float64Array;
  readonly grid: SpatialGrid;
  readonly neighbors: Int32Array;
  /** Sound triggers, read by the presentation only. Not part of the state hash. */
  readonly cues: SurvivorsCues;
}

/**
 * Starts a run with one hero per id in `heroIds`, drawing from the run's `seed`. Throws a
 * RangeError for no heroes or more than 4. A run starts with nothing to report, so of the run's
 * context it takes only the seed.
 */
export const createWorld = (
  { content, heroIds }: SurvivorsConfig,
  { seed }: Pick<Game.RunContext<never>, "seed">
): World => {
  if (heroIds.length === 0 || heroIds.length > MAX_HEROES) {
    throw new RangeError(
      `A survivors run has 1 to ${MAX_HEROES} heroes, not ${heroIds.length}`
    );
  }
  const cap = content.rules.maxEnemies;
  return {
    content,
    rng: makeRng(seed),
    time: 0,
    kills: 0,
    status: "running",
    level: 1,
    xp: 0,
    xpNext: content.rules.xpToLevel2,
    pendingLevelUps: 0,
    offerSeq: 0,
    spawnCursor: 0,
    heroes: heroIds.map((id, slot) => createHero(content, id, slot)),
    enemyDefs: content.enemies,
    enemyTypeById: new Map(content.enemies.map((e, i) => [e.id, i])),
    enemies: createPool(cap, ENEMY_LAYOUT),
    projectiles: createPool(MAX_PROJECTILES, PROJECTILE_LAYOUT),
    gems: createPool(MAX_GEMS, GEM_LAYOUT),
    spawnBudget: new Float64Array(content.waves.length),
    grid: new SpatialGrid({
      halfSize: content.rules.arenaHalfSize,
      cellSize: 2,
      capacity: cap,
    }),
    neighbors: new Int32Array(NEIGHBOR_BUFFER),
    cues: {
      shots: new Uint32Array(content.weapons.length),
      hits: 0,
      kills: 0,
      pickups: 0,
      hurt: new Uint32Array(heroIds.length),
      downed: new Uint32Array(heroIds.length),
      levelUps: 0,
      won: 0,
      lost: 0,
    },
  };
};

/** What the `Hud` sample carries. */
export const hudSample = (world: World): Omit<Hud, "_tag"> => ({
  level: world.level,
  xp: world.xp,
  xpNext: world.xpNext,
  time: world.time,
  runLength: world.content.rules.runLength,
  kills: world.kills,
  enemies: world.enemies.count,
  heroes: world.heroes.map((hero) => ({
    heroId: hero.def.id,
    hp: hero.hp,
    maxHp: hero.maxHp,
    status: hero.status,
    paused: hero.paused,
  })),
});

/**
 * The HUD sample's version: it moves when the run ends, so the loop reads the HUD right after the
 * frame that ended the run and the UI shows the run's last numbers.
 */
export const hudVersion = (world: World): number =>
  world.status === "running" ? 0 : 1;

/** True while some hero has an upgrade offer open: the run is frozen until every one is closed. */
export const isChoosing = (world: World): boolean => {
  for (const hero of world.heroes) {
    if (hero.offer !== null) {
      return true;
    }
  }
  return false;
};

const anyPlaying = (world: World): boolean => {
  for (const hero of world.heroes) {
    if (hero.status === "playing") {
      return true;
    }
  }
  return false;
};

// ---------------------------------------------------------------------------
// The step function

/**
 * Advances the run by one step of `dt` seconds. First the heroes in `input.leaving` leave; then
 * the run stays frozen while any hero has an upgrade offer open, or while any playing hero holds
 * it paused (`HoldPause`). The step's commands (a pick, a pause) were applied before it. Does
 * nothing once the run is over.
 */
export const step = (
  world: World,
  input: SurvivorsInput,
  { dt, report }: Game.StepContext<HeroLeft | LeveledUp | RunEnded>
): void => {
  if (world.status !== "running") {
    return;
  }
  for (const slot of input.leaving) {
    leave(world, slot, report);
  }
  if (!anyPlaying(world)) {
    endRun(world, "dead", report);
    return;
  }
  if (isChoosing(world) || isPauseHeld(world)) {
    return;
  }
  world.time += dt;

  moveHeroes(world, input, dt);
  spawnEnemies(world, dt);
  moveEnemies(world, dt);
  world.grid.build(
    world.enemies.fields.x,
    world.enemies.fields.z,
    world.enemies.count
  );
  touchHeroes(world, dt);
  fireWeapons(world, dt);
  moveProjectiles(world, dt);
  removeDeadEnemies(world);
  collectGems(world, dt);

  for (const hero of world.heroes) {
    if (hero.status !== "playing") {
      continue;
    }
    hero.hp = Math.min(hero.maxHp, hero.hp + hero.stats.regen * dt);
    if (hero.hp <= 0) {
      hero.hp = 0;
      hero.status = "down";
      // A hero that is down holds no pause. No run reaches this line with one held, since a
      // held pause freezes the step before it; the line keeps the rule true whatever a later
      // one does.
      hero.paused = false;
      world.cues.downed[hero.slot]! += 1;
    }
  }
  if (!anyPlaying(world)) {
    endRun(world, "dead", report);
  } else if (world.time >= world.content.rules.runLength) {
    endRun(world, "won", report);
  } else if (world.pendingLevelUps > 0) {
    offerUpgrades(world, report);
  }
};

const heroInput = (input: SurvivorsInput, hero: Hero): HeroInput | null =>
  input.players[hero.slot] ?? null;

/** The hero in `slot` leaves the run: it is no longer drawn or chased, and its open offer closes. */
const leave = (
  world: World,
  slot: number,
  report: (event: HeroLeft) => void
) => {
  const hero = world.heroes[slot];
  if (!hero || hero.status === "left") {
    return;
  }
  hero.status = "left";
  hero.paused = false;
  closeOffer(world, hero);
  report(new HeroLeft({ hero: slot }));
};

/**
 * True while a playing hero holds the run paused (`HoldPause`). The handler takes a hold only
 * from a playing hero, and going down or leaving lets go of it; asking for `playing` here as
 * well means no path that forgets to let go can freeze every peer for good.
 */
const isPauseHeld = (world: World): boolean => {
  for (const hero of world.heroes) {
    if (hero.paused && hero.status === "playing") {
      return true;
    }
  }
  return false;
};

/** Ends the run, and reports it. The HUD's version moves with the status, so the loop samples it next. */
const endRun = (
  world: World,
  status: "won" | "dead",
  report: (event: RunEnded) => void
) => {
  world.status = status;
  if (status === "won") {
    world.cues.won += 1;
  } else {
    world.cues.lost += 1;
  }
  report(
    new RunEnded({
      summaries: world.heroes.map((hero) => ({
        won: status === "won",
        heroId: hero.def.id,
        heroName: hero.def.name,
        time: world.time,
        kills: world.kills,
        level: world.level,
      })),
    })
  );
};

const moveHeroes = (world: World, input: SurvivorsInput, dt: number) => {
  const limit = world.content.rules.arenaHalfSize - 1;
  for (const hero of world.heroes) {
    if (hero.status !== "playing") {
      continue;
    }
    const move = heroInput(input, hero);
    let mx = move === null ? 0 : move.moveX;
    let mz = move === null ? 0 : move.moveZ;
    const len = hypot2(mx, mz);
    if (len > 1) {
      mx /= len;
      mz /= len;
    }
    if (len > 0.05) {
      hero.faceX = mx;
      hero.faceZ = mz;
    }
    hero.x = clamp(hero.x + mx * hero.stats.moveSpeed * dt, -limit, limit);
    hero.z = clamp(hero.z + mz * hero.stats.moveSpeed * dt, -limit, limit);
    hero.hurtTimer = Math.max(0, hero.hurtTimer - dt);
  }
};

/** The playing hero the next enemy spawns around: the heroes take turns, in slot order. */
const nextSpawnHero = (world: World): Hero => {
  const { heroes } = world;
  for (let k = 0; k < heroes.length; k++) {
    const slot = (world.spawnCursor + k) % heroes.length;
    const hero = heroes[slot]!;
    if (hero.status === "playing") {
      world.spawnCursor = (slot + 1) % heroes.length;
      return hero;
    }
  }
  // The step ends a run with no playing hero before anything spawns.
  return heroes[0]!;
};

const spawnEnemies = (world: World, dt: number) => {
  const { waves, rules } = world.content;
  const { x, z, hp, type, hitFlash } = world.enemies.fields;
  const limit = rules.arenaHalfSize - 1;
  for (let w = 0; w < waves.length; w++) {
    const wave = waves[w]!;
    if (world.time < wave.from || world.time >= wave.to) {
      continue;
    }
    world.spawnBudget[w]! += wave.perSecond * dt;
    const enemyType = world.enemyTypeById.get(wave.enemy)!;
    while (world.spawnBudget[w]! >= 1) {
      world.spawnBudget[w]! -= 1;
      const i = world.enemies.add();
      if (i === -1) {
        continue;
      }
      const hero = nextSpawnHero(world);
      const angle = world.rng.next() * Math.PI * 2;
      const distance = world.rng.range(SPAWN_DISTANCE_MIN, SPAWN_DISTANCE_MAX);
      x[i] = clamp(hero.x + cos(angle) * distance, -limit, limit);
      z[i] = clamp(hero.z + sin(angle) * distance, -limit, limit);
      hp[i] = world.enemyDefs[enemyType]!.hp;
      type[i] = enemyType;
      hitFlash[i] = 0;
    }
  }
};

/**
 * The playing hero nearest (x, z), by squared distance, with exact arithmetic; the lowest slot
 * wins a tie. Null if no hero is playing.
 */
const nearestHero = (world: World, x: number, z: number): Hero | null => {
  let best: Hero | null = null;
  let bestD2 = Infinity;
  for (const hero of world.heroes) {
    if (hero.status !== "playing") {
      continue;
    }
    const dx = hero.x - x;
    const dz = hero.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) {
      best = hero;
      bestD2 = d2;
    }
  }
  return best;
};

const moveEnemies = (world: World, dt: number) => {
  const { x, z, type, hitFlash } = world.enemies.fields;
  const { count } = world.enemies;
  // Chase the nearest hero.
  for (let i = 0; i < count; i++) {
    const def = world.enemyDefs[type[i]!]!;
    const hero = nearestHero(world, x[i]!, z[i]!);
    if (hero !== null) {
      const dx = hero.x - x[i]!;
      const dz = hero.z - z[i]!;
      const d = hypot2(dx, dz) || 1;
      x[i]! += (dx / d) * def.speed * dt;
      z[i]! += (dz / d) * def.speed * dt;
    }
    hitFlash[i] = Math.max(0, hitFlash[i]! - dt);
  }
  // Push overlapping enemies apart so the horde spreads out instead of stacking.
  world.grid.build(x, z, count);
  for (let i = 0; i < count; i++) {
    const ri = world.enemyDefs[type[i]!]!.radius;
    const found = world.grid.query(x[i]!, z[i]!, ri + 0.8, world.neighbors);
    for (let k = 0; k < found; k++) {
      const j = world.neighbors[k]!;
      if (j <= i) {
        continue;
      }
      const rj = world.enemyDefs[type[j]!]!.radius;
      const dx = x[j]! - x[i]!;
      const dz = z[j]! - z[i]!;
      const d = hypot2(dx, dz);
      const overlap = ri + rj - d;
      if (overlap <= 0 || d === 0) {
        continue;
      }
      const push = (overlap / d) * 0.5;
      x[i]! -= dx * push;
      z[i]! -= dz * push;
      x[j]! += dx * push;
      z[j]! += dz * push;
    }
  }
};

const touchHeroes = (world: World, dt: number) => {
  const { x, z, type } = world.enemies.fields;
  for (const hero of world.heroes) {
    if (hero.status !== "playing") {
      continue;
    }
    const found = world.grid.query(
      hero.x,
      hero.z,
      PLAYER_RADIUS + 1,
      world.neighbors
    );
    let hurt = false;
    for (let k = 0; k < found; k++) {
      const i = world.neighbors[k]!;
      const def = world.enemyDefs[type[i]!]!;
      if (hypot2(x[i]! - hero.x, z[i]! - hero.z) < def.radius + PLAYER_RADIUS) {
        hero.hp -= def.damage * dt;
        hero.hurtTimer = 0.15;
        hurt = true;
      }
    }
    if (hurt) {
      world.cues.hurt[hero.slot]! += 1;
    }
  }
};

const fireWeapons = (world: World, dt: number) => {
  for (const hero of world.heroes) {
    if (hero.status !== "playing") {
      continue;
    }
    for (let w = 0; w < hero.weapons.length; w++) {
      const slot = hero.weapons[w]!;
      slot.sinceFired += dt;
      slot.timer -= dt;
      if (slot.timer > 0) {
        continue;
      }
      const fired =
        slot.def.behavior.kind === "bolt"
          ? fireBolt(world, hero, slot, hero.slot * MAX_WEAPONS + w)
          : pulseAura(world, hero, slot);
      if (fired) {
        slot.timer = weaponCooldown(hero, slot);
        slot.sinceFired = 0;
      }
    }
  }
};

const fireBolt = (
  world: World,
  p: Hero,
  slot: WeaponSlot,
  weaponIndex: number
): boolean => {
  const { behavior } = slot.def;
  if (behavior.kind !== "bolt") {
    return false;
  }
  const e = world.enemies.fields;
  const enemyCount = world.enemies.count;
  const shots = Math.floor(
    behavior.count + behavior.countPerLevel * (slot.level - 1)
  );
  const range = behavior.range * p.stats.areaMult;
  // Pick the `shots` nearest enemies in range. Shots is small, so a simple scan is fine.
  const targets = world.neighbors;
  let targetCount = 0;
  for (let s = 0; s < shots && s < targets.length; s++) {
    let best = -1;
    let bestD = range;
    for (let i = 0; i < enemyCount; i++) {
      const d = hypot2(e.x[i]! - p.x, e.z[i]! - p.z);
      if (d >= bestD) {
        continue;
      }
      let taken = false;
      for (let t = 0; t < targetCount; t++) {
        if (targets[t] === i) {
          taken = true;
        }
      }
      if (!taken) {
        best = i;
        bestD = d;
      }
    }
    if (best === -1) {
      break;
    }
    targets[targetCount] = best;
    targetCount += 1;
  }
  if (targetCount === 0) {
    return false;
  }
  const pr = world.projectiles.fields;
  const damage = weaponDamage(p, slot);
  const defIndex = world.content.weapons.indexOf(slot.def);
  for (let t = 0; t < shots; t++) {
    const i = world.projectiles.add();
    if (i === -1) {
      break;
    }
    // Extra shots beyond the number of targets reuse the nearest ones.
    const target = targets[t % targetCount]!;
    const dx = e.x[target]! - p.x;
    const dz = e.z[target]! - p.z;
    const d = hypot2(dx, dz) || 1;
    pr.x[i] = p.x;
    pr.z[i] = p.z;
    pr.vx[i] = (dx / d) * behavior.projectileSpeed;
    pr.vz[i] = (dz / d) * behavior.projectileSpeed;
    pr.damage[i] = damage;
    pr.life[i] = (range / behavior.projectileSpeed) * 1.3;
    pr.pierce[i] = behavior.pierce;
    pr.rehit[i] = 0;
    pr.weapon[i] = weaponIndex;
    world.cues.shots[defIndex]! += 1;
  }
  return true;
};

const pulseAura = (world: World, p: Hero, slot: WeaponSlot): boolean => {
  const { x, z, type } = world.enemies.fields;
  const radius = auraRadius(p, slot);
  const damage = weaponDamage(p, slot);
  const found = world.grid.query(p.x, p.z, radius + 1, world.neighbors);
  for (let k = 0; k < found; k++) {
    const i = world.neighbors[k]!;
    const r = world.enemyDefs[type[i]!]!.radius;
    if (hypot2(x[i]! - p.x, z[i]! - p.z) < radius + r) {
      hitEnemy(world, i, damage);
    }
  }
  return true;
};

const moveProjectiles = (world: World, dt: number) => {
  const pool = world.projectiles;
  const pr = pool.fields;
  const e = world.enemies.fields;
  let i = 0;
  while (i < pool.count) {
    pr.x[i]! += pr.vx[i]! * dt;
    pr.z[i]! += pr.vz[i]! * dt;
    pr.life[i]! -= dt;
    pr.rehit[i] = Math.max(0, pr.rehit[i]! - dt);
    let spent = pr.life[i]! <= 0;
    if (!spent && pr.rehit[i] === 0) {
      const found = world.grid.query(pr.x[i]!, pr.z[i]!, 1.2, world.neighbors);
      for (let k = 0; k < found; k++) {
        const j = world.neighbors[k]!;
        if (e.hp[j]! <= 0) {
          continue;
        }
        const r = world.enemyDefs[e.type[j]!]!.radius;
        if (hypot2(e.x[j]! - pr.x[i]!, e.z[j]! - pr.z[i]!) > r + 0.25) {
          continue;
        }
        hitEnemy(world, j, pr.damage[i]!);
        world.cues.hits += 1;
        if (pr.pierce[i] === 0) {
          spent = true;
        } else {
          pr.pierce[i]! -= 1;
          pr.rehit[i] = PROJECTILE_REHIT_DELAY;
        }
        break;
      }
    }
    if (spent) {
      pool.remove(i);
    } else {
      i += 1;
    }
  }
};

const hitEnemy = (world: World, i: number, damage: number) => {
  world.enemies.fields.hp[i]! -= damage;
  world.enemies.fields.hitFlash[i] = 0.1;
};

const removeDeadEnemies = (world: World) => {
  const e = world.enemies.fields;
  const g = world.gems.fields;
  for (let i = world.enemies.count - 1; i >= 0; i--) {
    if (e.hp[i]! > 0) {
      continue;
    }
    world.kills += 1;
    world.cues.kills += 1;
    const { xp } = world.enemyDefs[e.type[i]!]!;
    if (xp > 0) {
      const k = world.gems.add();
      if (k === -1) {
        // Too many gems on the floor: grant the XP directly.
        gainXp(world, xp);
      } else {
        g.x[k] = e.x[i]!;
        g.z[k] = e.z[i]!;
        g.value[k] = xp;
        g.magnet[k] = 0;
      }
    }
    world.enemies.remove(i);
  }
};

const collectGems = (world: World, dt: number) => {
  const pool = world.gems;
  const g = pool.fields;
  let i = 0;
  while (i < pool.count) {
    // Gems fly to, and are collected by, the nearest hero.
    const p = nearestHero(world, g.x[i]!, g.z[i]!);
    if (p === null) {
      return;
    }
    const dx = p.x - g.x[i]!;
    const dz = p.z - g.z[i]!;
    const d = hypot2(dx, dz);
    if (d < p.stats.pickupRadius) {
      g.magnet[i] = 1;
    }
    if (g.magnet[i] === 1 && d > 0) {
      const move = Math.min(d, GEM_MAGNET_SPEED * dt);
      g.x[i]! += (dx / d) * move;
      g.z[i]! += (dz / d) * move;
    }
    if (d < GEM_PICKUP_DISTANCE) {
      world.cues.pickups += 1;
      gainXp(world, g.value[i]!);
      pool.remove(i);
    } else {
      i += 1;
    }
  }
};

/** Feeds the team's XP. Each level gained is a pending level-up. */
const gainXp = (world: World, amount: number) => {
  world.xp += amount;
  while (world.xp >= world.xpNext) {
    world.xp -= world.xpNext;
    world.level += 1;
    world.xpNext = Math.ceil(
      world.content.rules.xpToLevel2 *
        powInt(world.content.rules.xpGrowth, world.level - 1)
    );
    world.pendingLevelUps += 1;
    world.cues.levelUps += 1;
  }
};

// ---------------------------------------------------------------------------
// Upgrades

/** Opens a new offer: every playing hero, in slot order, gets its own choices. */
const offerUpgrades = (world: World, report: (event: LeveledUp) => void) => {
  world.offerSeq += 1;
  for (const hero of world.heroes) {
    if (hero.status !== "playing") {
      continue;
    }
    hero.offer = rollUpgrades(world.content, world.rng, hero);
    report(
      new LeveledUp({
        hero: hero.slot,
        offer: world.offerSeq,
        // A copy, so the event shares nothing with the state.
        choices: hero.offer.map((choice) => ({ ...choice })),
      })
    );
  }
};

/** Closes a hero's offer. Once no hero has one open, that level-up is done and the run resumes. */
const closeOffer = (world: World, hero: Hero) => {
  if (hero.offer === null) {
    return;
  }
  hero.offer = null;
  if (!isChoosing(world)) {
    world.pendingLevelUps -= 1;
  }
};

/**
 * The hero takes the choice at `index` of its open offer, and the offer closes. Returns false,
 * having changed nothing, if it has no open offer or the offer has no such choice. Every pick
 * ends here: the `ChooseUpgrade` command's handler calls it, in a single-player run and in a
 * lockstep run alike.
 */
export const choose = (world: World, hero: Hero, index: number): boolean => {
  const choice = hero.offer?.[index];
  if (!choice) {
    return false;
  }
  applyChoice(world.content, hero, choice);
  closeOffer(world, hero);
  return true;
};
