import type { EnemyDef, GameContent, HeroDef, WeaponDef } from '../content/schema'
import { SpatialGrid } from './grid'
import { type Rng, makeRng } from './rng'

// The simulation: plain data and plain functions, no Effect, no Three.js, no DOM.
// Large collections are "structure of arrays" (one typed array per field) so the
// per-frame loop allocates nothing and the garbage collector never causes a stutter.

export const PLAYER_RADIUS = 0.5
const MAX_PROJECTILES = 512
const MAX_GEMS = 1024
const NEIGHBOR_BUFFER = 256
const PROJECTILE_REHIT_DELAY = 0.15
const GEM_PICKUP_DISTANCE = 0.6
const GEM_MAGNET_SPEED = 18
const SPAWN_DISTANCE_MIN = 16
const SPAWN_DISTANCE_MAX = 22

export interface Input {
  /** Movement direction, each axis in [-1, 1]. */
  readonly moveX: number
  readonly moveZ: number
}

export interface WeaponSlot {
  readonly def: WeaponDef
  level: number
  /** Seconds until the next attack. */
  timer: number
  /** Seconds since the last attack; the renderer uses it for attack flashes. */
  sinceFired: number
}

export interface Stats {
  maxHpMult: number
  moveSpeed: number
  damageMult: number
  cooldownMult: number
  areaMult: number
  pickupRadius: number
  regen: number
}

export type RunStatus = 'running' | 'won' | 'dead'

export interface UpgradeChoice {
  readonly kind: 'weapon' | 'passive' | 'heal'
  readonly id: string
  readonly name: string
  readonly description: string
  /** Level the item reaches if picked. */
  readonly level: number
}

export interface World {
  readonly content: GameContent
  readonly hero: HeroDef
  readonly rng: Rng
  time: number
  kills: number
  status: RunStatus
  readonly player: {
    x: number
    z: number
    hp: number
    maxHp: number
    level: number
    xp: number
    xpNext: number
    faceX: number
    faceZ: number
    hurtTimer: number
  }
  stats: Stats
  readonly weapons: WeaponSlot[]
  readonly passiveLevels: Map<string, number>
  readonly enemyDefs: ReadonlyArray<EnemyDef>
  readonly enemyTypeById: ReadonlyMap<string, number>
  readonly enemies: {
    count: number
    readonly x: Float32Array
    readonly z: Float32Array
    readonly hp: Float32Array
    readonly type: Uint16Array
    readonly hitFlash: Float32Array
  }
  readonly projectiles: {
    count: number
    readonly x: Float32Array
    readonly z: Float32Array
    readonly vx: Float32Array
    readonly vz: Float32Array
    readonly damage: Float32Array
    readonly life: Float32Array
    readonly pierce: Uint8Array
    readonly rehit: Float32Array
    /** Index into `weapons`, so the renderer can color projectiles. */
    readonly weapon: Uint8Array
  }
  readonly gems: {
    count: number
    readonly x: Float32Array
    readonly z: Float32Array
    readonly value: Float32Array
    readonly magnet: Uint8Array
  }
  readonly spawnBudget: Float64Array
  pendingLevelUps: number
  /** Set while the run waits for the player to pick an upgrade. The simulation is frozen meanwhile. */
  offer: ReadonlyArray<UpgradeChoice> | null
  readonly grid: SpatialGrid
  readonly neighbors: Int32Array
}

export const createWorld = (content: GameContent, heroId: string, seed: number): World => {
  const hero = content.heroes.find(h => h.id === heroId) ?? content.heroes[0]
  const startingWeapon = content.weapons.find(w => w.id === hero.startingWeapon)!
  const cap = content.rules.maxEnemies
  const world: World = {
    content,
    hero,
    rng: makeRng(seed),
    time: 0,
    kills: 0,
    status: 'running',
    player: {
      x: 0,
      z: 0,
      hp: hero.maxHp,
      maxHp: hero.maxHp,
      level: 1,
      xp: 0,
      xpNext: content.rules.xpToLevel2,
      faceX: 0,
      faceZ: 1,
      hurtTimer: 0,
    },
    stats: baseStats(content, hero),
    weapons: [{ def: startingWeapon, level: 1, timer: 0.5, sinceFired: 99 }],
    passiveLevels: new Map(),
    enemyDefs: content.enemies,
    enemyTypeById: new Map(content.enemies.map((e, i) => [e.id, i])),
    enemies: {
      count: 0,
      x: new Float32Array(cap),
      z: new Float32Array(cap),
      hp: new Float32Array(cap),
      type: new Uint16Array(cap),
      hitFlash: new Float32Array(cap),
    },
    projectiles: {
      count: 0,
      x: new Float32Array(MAX_PROJECTILES),
      z: new Float32Array(MAX_PROJECTILES),
      vx: new Float32Array(MAX_PROJECTILES),
      vz: new Float32Array(MAX_PROJECTILES),
      damage: new Float32Array(MAX_PROJECTILES),
      life: new Float32Array(MAX_PROJECTILES),
      pierce: new Uint8Array(MAX_PROJECTILES),
      rehit: new Float32Array(MAX_PROJECTILES),
      weapon: new Uint8Array(MAX_PROJECTILES),
    },
    gems: {
      count: 0,
      x: new Float32Array(MAX_GEMS),
      z: new Float32Array(MAX_GEMS),
      value: new Float32Array(MAX_GEMS),
      magnet: new Uint8Array(MAX_GEMS),
    },
    spawnBudget: new Float64Array(content.waves.length),
    pendingLevelUps: 0,
    offer: null,
    grid: new SpatialGrid(content.rules.arenaHalfSize, 2, cap),
    neighbors: new Int32Array(NEIGHBOR_BUFFER),
  }
  return world
}

const baseStats = (content: GameContent, hero: HeroDef): Stats => ({
  maxHpMult: 1,
  moveSpeed: hero.moveSpeed * content.rules.baseMoveSpeedScale,
  damageMult: 1,
  cooldownMult: 1,
  areaMult: 1,
  pickupRadius: content.rules.basePickupRadius,
  regen: 0,
})

/** Recomputes stats from passive levels. Called after every upgrade, never per frame. */
export const recomputeStats = (world: World): void => {
  const sum = { maxHp: 0, moveSpeed: 0, damage: 0, cooldown: 0, area: 0, pickupRadius: 0, regen: 0 }
  for (const passive of world.content.passives) {
    const level = world.passiveLevels.get(passive.id) ?? 0
    sum[passive.stat] += passive.amountPerLevel * level
  }
  const base = baseStats(world.content, world.hero)
  const previousMaxHp = world.player.maxHp
  world.stats = {
    maxHpMult: 1 + sum.maxHp,
    moveSpeed: base.moveSpeed * (1 + sum.moveSpeed),
    damageMult: 1 + sum.damage,
    cooldownMult: 1 / (1 + sum.cooldown),
    areaMult: 1 + sum.area,
    pickupRadius: base.pickupRadius * (1 + sum.pickupRadius),
    regen: sum.regen,
  }
  world.player.maxHp = world.hero.maxHp * world.stats.maxHpMult
  // Extra max HP arrives filled.
  world.player.hp += Math.max(0, world.player.maxHp - previousMaxHp)
}

// ---------------------------------------------------------------------------
// Weapon numbers (shared with the renderer so visuals match the rules)

export const weaponDamage = (world: World, slot: WeaponSlot): number =>
  (slot.def.damage + slot.def.damagePerLevel * (slot.level - 1)) * world.stats.damageMult

export const weaponCooldown = (world: World, slot: WeaponSlot): number =>
  slot.def.cooldown * Math.pow(slot.def.cooldownScalePerLevel, slot.level - 1) * world.stats.cooldownMult

export const auraRadius = (world: World, slot: WeaponSlot): number =>
  slot.def.behavior.kind === 'aura'
    ? (slot.def.behavior.radius + slot.def.behavior.radiusPerLevel * (slot.level - 1)) * world.stats.areaMult
    : 0

// ---------------------------------------------------------------------------
// The step function

/** Advances the run by `dt` seconds. Does nothing while an upgrade offer is open or the run is over. */
export const step = (world: World, input: Input, dt: number): void => {
  if (world.status !== 'running' || world.offer !== null) return
  world.time += dt

  movePlayer(world, input, dt)
  spawnEnemies(world, dt)
  moveEnemies(world, dt)
  world.grid.build(world.enemies.x, world.enemies.z, world.enemies.count)
  touchPlayer(world, dt)
  fireWeapons(world, dt)
  moveProjectiles(world, dt)
  removeDeadEnemies(world)
  collectGems(world, dt)

  const p = world.player
  p.hp = Math.min(p.maxHp, p.hp + world.stats.regen * dt)
  if (p.hp <= 0) {
    p.hp = 0
    world.status = 'dead'
  } else if (world.time >= world.content.rules.runLength) {
    world.status = 'won'
  } else if (world.pendingLevelUps > 0) {
    world.offer = rollUpgrades(world)
  }
}

const movePlayer = (world: World, input: Input, dt: number) => {
  const p = world.player
  let mx = input.moveX
  let mz = input.moveZ
  const len = Math.hypot(mx, mz)
  if (len > 1) {
    mx /= len
    mz /= len
  }
  if (len > 0.05) {
    p.faceX = mx
    p.faceZ = mz
  }
  const limit = world.content.rules.arenaHalfSize - 1
  p.x = clamp(p.x + mx * world.stats.moveSpeed * dt, -limit, limit)
  p.z = clamp(p.z + mz * world.stats.moveSpeed * dt, -limit, limit)
  p.hurtTimer = Math.max(0, p.hurtTimer - dt)
}

const spawnEnemies = (world: World, dt: number) => {
  const { waves, rules } = world.content
  const e = world.enemies
  const limit = rules.arenaHalfSize - 1
  for (let w = 0; w < waves.length; w++) {
    const wave = waves[w]!
    if (world.time < wave.from || world.time >= wave.to) continue
    world.spawnBudget[w]! += wave.perSecond * dt
    const type = world.enemyTypeById.get(wave.enemy)!
    while (world.spawnBudget[w]! >= 1) {
      world.spawnBudget[w]! -= 1
      if (e.count >= rules.maxEnemies) continue
      const angle = world.rng.next() * Math.PI * 2
      const distance = world.rng.range(SPAWN_DISTANCE_MIN, SPAWN_DISTANCE_MAX)
      const i = e.count++
      e.x[i] = clamp(world.player.x + Math.cos(angle) * distance, -limit, limit)
      e.z[i] = clamp(world.player.z + Math.sin(angle) * distance, -limit, limit)
      e.hp[i] = world.enemyDefs[type]!.hp
      e.type[i] = type
      e.hitFlash[i] = 0
    }
  }
}

const moveEnemies = (world: World, dt: number) => {
  const e = world.enemies
  const { x: px, z: pz } = world.player
  // Chase the player.
  for (let i = 0; i < e.count; i++) {
    const def = world.enemyDefs[e.type[i]!]!
    const dx = px - e.x[i]!
    const dz = pz - e.z[i]!
    const d = Math.hypot(dx, dz) || 1
    e.x[i]! += (dx / d) * def.speed * dt
    e.z[i]! += (dz / d) * def.speed * dt
    e.hitFlash[i] = Math.max(0, e.hitFlash[i]! - dt)
  }
  // Push overlapping enemies apart so the horde spreads out instead of stacking.
  world.grid.build(e.x, e.z, e.count)
  for (let i = 0; i < e.count; i++) {
    const ri = world.enemyDefs[e.type[i]!]!.radius
    const found = world.grid.query(e.x[i]!, e.z[i]!, ri + 0.8, world.neighbors)
    for (let k = 0; k < found; k++) {
      const j = world.neighbors[k]!
      if (j <= i) continue
      const rj = world.enemyDefs[e.type[j]!]!.radius
      const dx = e.x[j]! - e.x[i]!
      const dz = e.z[j]! - e.z[i]!
      const d = Math.hypot(dx, dz)
      const overlap = ri + rj - d
      if (overlap <= 0 || d === 0) continue
      const push = (overlap / d) * 0.5
      e.x[i]! -= dx * push
      e.z[i]! -= dz * push
      e.x[j]! += dx * push
      e.z[j]! += dz * push
    }
  }
}

const touchPlayer = (world: World, dt: number) => {
  const e = world.enemies
  const p = world.player
  const found = world.grid.query(p.x, p.z, PLAYER_RADIUS + 1, world.neighbors)
  for (let k = 0; k < found; k++) {
    const i = world.neighbors[k]!
    const def = world.enemyDefs[e.type[i]!]!
    if (Math.hypot(e.x[i]! - p.x, e.z[i]! - p.z) < def.radius + PLAYER_RADIUS) {
      p.hp -= def.damage * dt
      p.hurtTimer = 0.15
    }
  }
}

const fireWeapons = (world: World, dt: number) => {
  for (let w = 0; w < world.weapons.length; w++) {
    const slot = world.weapons[w]!
    slot.sinceFired += dt
    slot.timer -= dt
    if (slot.timer > 0) continue
    const fired = slot.def.behavior.kind === 'bolt' ? fireBolt(world, slot, w) : pulseAura(world, slot)
    if (fired) {
      slot.timer = weaponCooldown(world, slot)
      slot.sinceFired = 0
    }
  }
}

const fireBolt = (world: World, slot: WeaponSlot, weaponIndex: number): boolean => {
  const behavior = slot.def.behavior
  if (behavior.kind !== 'bolt') return false
  const e = world.enemies
  const p = world.player
  const shots = Math.floor(behavior.count + behavior.countPerLevel * (slot.level - 1))
  const range = behavior.range * world.stats.areaMult
  // Pick the `shots` nearest enemies in range. Shots is small, so a simple scan is fine.
  const targets = world.neighbors
  let targetCount = 0
  for (let s = 0; s < shots && s < targets.length; s++) {
    let best = -1
    let bestD = range
    for (let i = 0; i < e.count; i++) {
      const d = Math.hypot(e.x[i]! - p.x, e.z[i]! - p.z)
      if (d >= bestD) continue
      let taken = false
      for (let t = 0; t < targetCount; t++) if (targets[t] === i) taken = true
      if (!taken) {
        best = i
        bestD = d
      }
    }
    if (best === -1) break
    targets[targetCount++] = best
  }
  if (targetCount === 0) return false
  const pr = world.projectiles
  const damage = weaponDamage(world, slot)
  for (let t = 0; t < shots; t++) {
    if (pr.count >= pr.x.length) break
    // Extra shots beyond the number of targets reuse the nearest ones.
    const target = targets[t % targetCount]!
    const dx = e.x[target]! - p.x
    const dz = e.z[target]! - p.z
    const d = Math.hypot(dx, dz) || 1
    const i = pr.count++
    pr.x[i] = p.x
    pr.z[i] = p.z
    pr.vx[i] = (dx / d) * behavior.projectileSpeed
    pr.vz[i] = (dz / d) * behavior.projectileSpeed
    pr.damage[i] = damage
    pr.life[i] = (range / behavior.projectileSpeed) * 1.3
    pr.pierce[i] = behavior.pierce
    pr.rehit[i] = 0
    pr.weapon[i] = weaponIndex
  }
  return true
}

const pulseAura = (world: World, slot: WeaponSlot): boolean => {
  const e = world.enemies
  const p = world.player
  const radius = auraRadius(world, slot)
  const damage = weaponDamage(world, slot)
  const found = world.grid.query(p.x, p.z, radius + 1, world.neighbors)
  for (let k = 0; k < found; k++) {
    const i = world.neighbors[k]!
    const r = world.enemyDefs[e.type[i]!]!.radius
    if (Math.hypot(e.x[i]! - p.x, e.z[i]! - p.z) < radius + r) hitEnemy(world, i, damage)
  }
  return true
}

const moveProjectiles = (world: World, dt: number) => {
  const pr = world.projectiles
  const e = world.enemies
  let i = 0
  while (i < pr.count) {
    pr.x[i]! += pr.vx[i]! * dt
    pr.z[i]! += pr.vz[i]! * dt
    pr.life[i]! -= dt
    pr.rehit[i] = Math.max(0, pr.rehit[i]! - dt)
    let spent = pr.life[i]! <= 0
    if (!spent && pr.rehit[i] === 0) {
      const found = world.grid.query(pr.x[i]!, pr.z[i]!, 1.2, world.neighbors)
      for (let k = 0; k < found; k++) {
        const j = world.neighbors[k]!
        if (e.hp[j]! <= 0) continue
        const r = world.enemyDefs[e.type[j]!]!.radius
        if (Math.hypot(e.x[j]! - pr.x[i]!, e.z[j]! - pr.z[i]!) > r + 0.25) continue
        hitEnemy(world, j, pr.damage[i]!)
        if (pr.pierce[i] === 0) spent = true
        else {
          pr.pierce[i]! -= 1
          pr.rehit[i] = PROJECTILE_REHIT_DELAY
        }
        break
      }
    }
    if (spent) removeProjectile(world, i)
    else i++
  }
}

const removeProjectile = (world: World, i: number) => {
  const pr = world.projectiles
  const last = --pr.count
  pr.x[i] = pr.x[last]!
  pr.z[i] = pr.z[last]!
  pr.vx[i] = pr.vx[last]!
  pr.vz[i] = pr.vz[last]!
  pr.damage[i] = pr.damage[last]!
  pr.life[i] = pr.life[last]!
  pr.pierce[i] = pr.pierce[last]!
  pr.rehit[i] = pr.rehit[last]!
  pr.weapon[i] = pr.weapon[last]!
}

const hitEnemy = (world: World, i: number, damage: number) => {
  world.enemies.hp[i]! -= damage
  world.enemies.hitFlash[i] = 0.1
}

const removeDeadEnemies = (world: World) => {
  const e = world.enemies
  const g = world.gems
  for (let i = e.count - 1; i >= 0; i--) {
    if (e.hp[i]! > 0) continue
    world.kills++
    const xp = world.enemyDefs[e.type[i]!]!.xp
    if (xp > 0) {
      if (g.count < g.x.length) {
        const k = g.count++
        g.x[k] = e.x[i]!
        g.z[k] = e.z[i]!
        g.value[k] = xp
        g.magnet[k] = 0
      } else gainXp(world, xp) // Too many gems on the floor: grant the XP directly.
    }
    const last = --e.count
    e.x[i] = e.x[last]!
    e.z[i] = e.z[last]!
    e.hp[i] = e.hp[last]!
    e.type[i] = e.type[last]!
    e.hitFlash[i] = e.hitFlash[last]!
  }
}

const collectGems = (world: World, dt: number) => {
  const g = world.gems
  const p = world.player
  let i = 0
  while (i < g.count) {
    const dx = p.x - g.x[i]!
    const dz = p.z - g.z[i]!
    const d = Math.hypot(dx, dz)
    if (d < world.stats.pickupRadius) g.magnet[i] = 1
    if (g.magnet[i] === 1 && d > 0) {
      const move = Math.min(d, GEM_MAGNET_SPEED * dt)
      g.x[i]! += (dx / d) * move
      g.z[i]! += (dz / d) * move
    }
    if (d < GEM_PICKUP_DISTANCE) {
      gainXp(world, g.value[i]!)
      const last = --g.count
      g.x[i] = g.x[last]!
      g.z[i] = g.z[last]!
      g.value[i] = g.value[last]!
      g.magnet[i] = g.magnet[last]!
    } else i++
  }
}

const gainXp = (world: World, amount: number) => {
  const p = world.player
  p.xp += amount
  while (p.xp >= p.xpNext) {
    p.xp -= p.xpNext
    p.level++
    p.xpNext = Math.ceil(world.content.rules.xpToLevel2 * Math.pow(world.content.rules.xpGrowth, p.level - 1))
    world.pendingLevelUps++
  }
}

// ---------------------------------------------------------------------------
// Upgrades

const MAX_WEAPONS = 4

const rollUpgrades = (world: World): ReadonlyArray<UpgradeChoice> => {
  const candidates: UpgradeChoice[] = []
  for (const def of world.content.weapons) {
    const slot = world.weapons.find(s => s.def.id === def.id)
    if (slot && slot.level < def.maxLevel) {
      candidates.push({ kind: 'weapon', id: def.id, name: def.name, description: `Stronger and faster.`, level: slot.level + 1 })
    } else if (!slot && world.weapons.length < MAX_WEAPONS) {
      candidates.push({ kind: 'weapon', id: def.id, name: def.name, description: def.description, level: 1 })
    }
  }
  for (const def of world.content.passives) {
    const level = world.passiveLevels.get(def.id) ?? 0
    if (level < def.maxLevel) {
      candidates.push({ kind: 'passive', id: def.id, name: def.name, description: def.description, level: level + 1 })
    }
  }
  // Partial Fisher-Yates shuffle with the run's seeded RNG, so runs stay reproducible.
  const count = Math.min(world.content.rules.choicesPerLevelUp, candidates.length)
  for (let i = 0; i < count; i++) {
    const j = i + world.rng.int(candidates.length - i)
    ;[candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!]
  }
  const picks = candidates.slice(0, count)
  return picks.length > 0
    ? picks
    : [{ kind: 'heal', id: 'heal', name: 'Snack', description: 'Restore 30% of your HP.', level: 1 }]
}

/** Applies the chosen upgrade and closes the offer. Returns false if there was no open offer or the index is wrong. */
export const chooseUpgrade = (world: World, index: number): boolean => {
  const choice = world.offer?.[index]
  if (!choice) return false
  if (choice.kind === 'weapon') {
    const slot = world.weapons.find(s => s.def.id === choice.id)
    if (slot) slot.level = choice.level
    else {
      const def = world.content.weapons.find(w => w.id === choice.id)!
      world.weapons.push({ def, level: 1, timer: 0, sinceFired: 99 })
    }
  } else if (choice.kind === 'passive') {
    world.passiveLevels.set(choice.id, choice.level)
    recomputeStats(world)
  } else {
    world.player.hp = Math.min(world.player.maxHp, world.player.hp + world.player.maxHp * 0.3)
  }
  world.offer = null
  world.pendingLevelUps--
  return true
}

const clamp = (v: number, min: number, max: number) => (v < min ? min : v > max ? max : v)
