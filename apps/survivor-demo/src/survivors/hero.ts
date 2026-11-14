/**
 * Heroes: what each player owns in a survivors run, and what crosses between the player and the
 * run.
 *
 * A run has one hero per player, at the player's slot: its body, stats, weapons, passives and the
 * upgrade offer it is choosing from. Everything shared (the clock, the team's XP, the horde, the
 * gems, the projectiles, the `Rng`) is the arena's (`World.Arena`). One player's input for a step
 * is a `Hero.Input`, and how the run ended for one hero a `Hero.Summary`.
 *
 * Plain on purpose: a step changes its heroes, so a hero's functions give the same bits on every
 * peer and every replay, and finish in the call.
 */
import { ExactMath } from "arcadekit/core";
import { Schema } from "effect";

import type * as GameContent from "./game-content";
import type * as Offer from "./offer";

/**
 * One player's input for one step, as a Schema: the direction its devices hold, each axis in
 * [-1, 1].
 *
 * **When to use**
 *
 * As the one-player Schema a run's step input is made from (`World.Input`), which a lockstep
 * session reads to send each player's input over the network.
 *
 * **Details**
 *
 * A move longer than 1 is shortened to 1, so a diagonal is no faster; a hero turns to face a
 * move longer than 0.05.
 *
 * **Example** (Checking one player's input)
 *
 * ```ts
 * import { Hero } from "#survivors";
 * import { Schema } from "effect";
 *
 * Schema.is(Hero.Input)({ moveX: 1, moveZ: -0.5 }); // => true
 * Schema.is(Hero.Input)({ moveX: 1 }); // => false
 * ```
 *
 * @category schemas
 */
export const Input = Schema.Struct({
  moveX: Schema.Number,
  moveZ: Schema.Number,
});

/**
 * One player's input for one step: what an input source for one player gives.
 *
 * **When to use**
 *
 * To type one player's input source or script, as a replay, a bench or a co-op test writes one.
 *
 * **Example** (A script that walks right)
 *
 * ```ts
 * import type { Hero } from "#survivors";
 * import * as Game from "arcadekit/game";
 *
 * const right: Game.StepInput<Hero.Input> = { read: () => ({ moveX: 1, moveZ: 0 }) };
 * Game.soloInput(right).read(0); // => { players: [{ moveX: 1, moveZ: 0 }], leaving: [] }
 * ```
 *
 * @category models
 */
export type Input = typeof Input.Type;

/**
 * How the run ended for one hero, as a Schema: whether it was won, the hero played, and the
 * team's time, kills and level. `RunEnded` carries one for each hero.
 *
 * **When to use**
 *
 * In an app's Model and Messages, to show the end screen and keep a hero's best run.
 *
 * **Details**
 *
 * `heroId` is the hero actually played: a run given an unknown id plays the content's first
 * hero, and names it here. Time is in seconds of the run.
 *
 * **Example** (A won run's summary)
 *
 * ```ts
 * import { Hero } from "#survivors";
 * import { Schema } from "effect";
 *
 * const summary = Schema.decodeUnknownSync(Hero.Summary)({
 *   won: true,
 *   heroId: "bolter",
 *   heroName: "Bolter",
 *   time: 600,
 *   kills: 1200,
 *   level: 24,
 * });
 * [summary.won, summary.kills]; // => [true, 1200]
 * ```
 *
 * @category schemas
 */
export const Summary = Schema.Struct({
  won: Schema.Boolean,
  /** The id of the hero that was played. An unknown id falls back to the first hero, so this is the one actually played. */
  heroId: Schema.String,
  heroName: Schema.String,
  time: Schema.Number,
  kills: Schema.Int,
  level: Schema.Int,
});

/**
 * How the run ended for one hero.
 *
 * **When to use**
 *
 * To type what an app keeps of a run, such as a hero's best time in its save.
 *
 * **Example** (The longer of two runs)
 *
 * ```ts
 * import type { Hero } from "#survivors";
 *
 * const longer = (a: Hero.Summary, b: Hero.Summary) => (b.time > a.time ? b : a);
 * const first = { won: false, heroId: "bolter", heroName: "Bolter", time: 42, kills: 80, level: 6 };
 * longer(first, { ...first, time: 50 }).time; // => 50
 * ```
 *
 * @category models
 */
export type Summary = typeof Summary.Type;

/**
 * The most heroes a run holds: one per player, so 1 for one player and 2 to 4 in co-op.
 *
 * **When to use**
 *
 * As a co-op game's most players, and to size what a view keeps for each hero's slot.
 *
 * **Example** (The most players)
 *
 * ```ts
 * import { Hero } from "#survivors";
 *
 * Hero.maxPerRun; // => 4
 * ```
 *
 * @category models
 */
export const maxPerRun = 4;

/**
 * The most weapons one hero carries. An offer stops offering new weapons once a hero has this
 * many.
 *
 * **When to use**
 *
 * To size what a view keeps for each hero's weapons: a projectile's `weapon` field is the firing
 * hero's slot times this, plus the weapon's index in its slots.
 *
 * **Example** (The most weapons)
 *
 * ```ts
 * import { Hero } from "#survivors";
 *
 * Hero.maxWeapons; // => 4
 * ```
 *
 * @category models
 */
export const maxWeapons = 4;

/**
 * One weapon a hero carries: its definition, its level, and its timers.
 *
 * **When to use**
 *
 * To read a hero's weapons, as the rules fire them and a view draws an aura's pulse.
 *
 * **Details**
 *
 * A weapon attacks once its `timer` is down to 0, and its timer starts again from its cooldown
 * (`Hero.weaponCooldown`). A bolt with no enemy in range doesn't attack: its timer stays at 0 or
 * below until one comes. `sinceFired` grows each step and goes back to 0 with each attack: a
 * view fades an aura's pulse with it, and the rules never read it.
 *
 * **Example** (A hero's starting weapon)
 *
 * ```ts
 * import { GameContent, Hero } from "#survivors";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(GameContent.GameContent)({
 *   rules: {
 *     arenaHalfSize: 20, maxEnemies: 50, xpToLevel2: 5, xpGrowth: 1.3,
 *     baseMoveSpeedScale: 1, basePickupRadius: 2.5, choicesPerLevelUp: 3, runLength: 60,
 *   },
 *   heroes: [{ id: "bolter", name: "Bolter", description: "", color: "#ffffff", maxHp: 100, moveSpeed: 6, startingWeapon: "bolt" }],
 *   enemies: [{ id: "grunt", name: "Grunt", color: "#00ff00", hp: 8, speed: 2.5, damage: 10, radius: 0.45, xp: 1 }],
 *   weapons: [{
 *     id: "bolt", name: "Bolt", description: "", color: "#ffff00", damage: 10, damagePerLevel: 3,
 *     cooldown: 0.5, cooldownScalePerLevel: 0.9, maxLevel: 5,
 *     behavior: { kind: "bolt", projectileSpeed: 20, count: 1, countPerLevel: 0.5, pierce: 0, range: 14 },
 *   }],
 *   passives: [],
 *   waves: [{ from: 0, to: 60, enemy: "grunt", perSecond: 1 }],
 * });
 * const slot: Hero.WeaponSlot = Hero.make(content, "bolter", 0).weapons[0]!;
 * [slot.def.id, slot.level, slot.timer]; // => ["bolt", 1, 0.5]
 * ```
 *
 * @category models
 */
export interface WeaponSlot {
  readonly def: GameContent.WeaponDef;
  level: number;
  /** Seconds until the next attack. */
  timer: number;
  /** Seconds since the last attack; the view uses it for attack flashes. */
  sinceFired: number;
}

/**
 * A hero's stats: its passive upgrades applied to its definition and the content's rules.
 *
 * **When to use**
 *
 * To read how fast a hero moves, how hard and how often it hits, and how far it reaches, as the
 * rules do each step.
 *
 * **Details**
 *
 * They are worked out again from the hero's passive levels each time it takes a passive, never
 * per step. Each multiplier is 1 with no passive.
 *
 * **Example** (A hero's speed)
 *
 * ```ts
 * import { GameContent, Hero } from "#survivors";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(GameContent.GameContent)({
 *   rules: {
 *     arenaHalfSize: 20, maxEnemies: 50, xpToLevel2: 5, xpGrowth: 1.3,
 *     baseMoveSpeedScale: 1.5, basePickupRadius: 2.5, choicesPerLevelUp: 3, runLength: 60,
 *   },
 *   heroes: [{ id: "bolter", name: "Bolter", description: "", color: "#ffffff", maxHp: 100, moveSpeed: 6, startingWeapon: "bolt" }],
 *   enemies: [{ id: "grunt", name: "Grunt", color: "#00ff00", hp: 8, speed: 2.5, damage: 10, radius: 0.45, xp: 1 }],
 *   weapons: [{
 *     id: "bolt", name: "Bolt", description: "", color: "#ffff00", damage: 10, damagePerLevel: 3,
 *     cooldown: 0.5, cooldownScalePerLevel: 0.9, maxLevel: 5,
 *     behavior: { kind: "bolt", projectileSpeed: 20, count: 1, countPerLevel: 0.5, pierce: 0, range: 14 },
 *   }],
 *   passives: [],
 *   waves: [{ from: 0, to: 60, enemy: "grunt", perSecond: 1 }],
 * });
 * const stats: Hero.Stats = Hero.make(content, "bolter", 0).stats;
 * [stats.moveSpeed, stats.damageMult]; // => [9, 1]
 * ```
 *
 * @category models
 */
export interface Stats {
  maxHpMult: number;
  /** World units per second: the hero's speed times the rules' `baseMoveSpeedScale`, raised by passives. */
  moveSpeed: number;
  damageMult: number;
  /** Below 1 attacks faster. */
  cooldownMult: number;
  /** Multiplies a bolt's range and an aura's radius. */
  areaMult: number;
  pickupRadius: number;
  /** Hit points regained each second. */
  regen: number;
}

/**
 * One player's hero: its slot, its definition, where it stands and faces, its hit points, stats,
 * weapons and passives, its upgrade offer, and whether its player holds the run paused.
 *
 * **When to use**
 *
 * To read a hero in a view, a test or the HUD. Only the step and the commands change it.
 *
 * **Details**
 *
 * A hero's index in the arena's `heroes` is its slot, its player's place in player order (the host
 * first in lockstep), fixed for the whole run. Heroes are never removed: one whose player leaves
 * is marked `left`, so slots stay stable.
 *
 * **Example** (The second player's hero)
 *
 * ```ts
 * import { GameContent, Hero } from "#survivors";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(GameContent.GameContent)({
 *   rules: {
 *     arenaHalfSize: 20, maxEnemies: 50, xpToLevel2: 5, xpGrowth: 1.3,
 *     baseMoveSpeedScale: 1, basePickupRadius: 2.5, choicesPerLevelUp: 3, runLength: 60,
 *   },
 *   heroes: [{ id: "bolter", name: "Bolter", description: "", color: "#ffffff", maxHp: 100, moveSpeed: 6, startingWeapon: "bolt" }],
 *   enemies: [{ id: "grunt", name: "Grunt", color: "#00ff00", hp: 8, speed: 2.5, damage: 10, radius: 0.45, xp: 1 }],
 *   weapons: [{
 *     id: "bolt", name: "Bolt", description: "", color: "#ffff00", damage: 10, damagePerLevel: 3,
 *     cooldown: 0.5, cooldownScalePerLevel: 0.9, maxLevel: 5,
 *     behavior: { kind: "bolt", projectileSpeed: 20, count: 1, countPerLevel: 0.5, pierce: 0, range: 14 },
 *   }],
 *   passives: [],
 *   waves: [{ from: 0, to: 60, enemy: "grunt", perSecond: 1 }],
 * });
 * const hero: Hero.Hero = Hero.make(content, "bolter", 1);
 * [hero.slot, hero.x, hero.z, hero.hp, hero.status]; // => [1, 1.5, 0, 100, "playing"]
 * ```
 *
 * @category models
 */
export interface Hero {
  readonly slot: number;
  readonly def: GameContent.HeroDef;
  /**
   * - `playing`: in the run: moves, fights, collects gems, is chased and gets upgrade offers.
   * - `down`: out of hit points. It stays where it fell and does nothing; nothing revives it.
   * - `left`: its player left the run (lockstep removed them). The view no longer draws it.
   *
   * The run is lost once no hero is `playing`.
   */
  status: "playing" | "down" | "left";
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  /**
   * Its last move longer than 0.05, shortened to a length of 1 if it was longer: where it faces.
   * It faces +z at the start.
   */
  faceX: number;
  faceZ: number;
  /** Seconds it flashes for after taking contact damage. */
  hurtTimer: number;
  stats: Stats;
  readonly weapons: WeaponSlot[];
  /** Each passive's level, by the passive's id. */
  readonly passiveLevels: Map<string, number>;
  /** The upgrades this hero is choosing from, or null. The whole run is frozen while any hero has one. */
  offer: Offer.Offer | null;
  /**
   * True while this hero's player holds the run paused: the co-op pause, set by the `HoldPause`
   * command. Only a playing hero holds it: going down or leaving lets go.
   */
  paused: boolean;
}

/** Where each slot's hero starts. The first hero starts at the centre, as a single player always has. */
const START = [
  [0, 0],
  [1.5, 0],
  [-1.5, 0],
  [0, -1.5],
] as const;

/**
 * Makes the hero for `slot`, from the content's hero `heroId`: at its slot's place, with full
 * hit points, its starting weapon, no passive and no offer.
 *
 * **When to use**
 *
 * Rarely: `World.make` makes one per id of a run's config. A test of a hero's numbers makes one
 * alone.
 *
 * **Details**
 *
 * An unknown id plays the content's first hero. The first slot starts at the centre and the
 * others around it. Its starting weapon's timer starts at half a second, so it attacks no sooner.
 *
 * **Example** (An unknown id plays the first hero)
 *
 * ```ts
 * import { GameContent, Hero } from "#survivors";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(GameContent.GameContent)({
 *   rules: {
 *     arenaHalfSize: 20, maxEnemies: 50, xpToLevel2: 5, xpGrowth: 1.3,
 *     baseMoveSpeedScale: 1, basePickupRadius: 2.5, choicesPerLevelUp: 3, runLength: 60,
 *   },
 *   heroes: [{ id: "bolter", name: "Bolter", description: "", color: "#ffffff", maxHp: 100, moveSpeed: 6, startingWeapon: "bolt" }],
 *   enemies: [{ id: "grunt", name: "Grunt", color: "#00ff00", hp: 8, speed: 2.5, damage: 10, radius: 0.45, xp: 1 }],
 *   weapons: [{
 *     id: "bolt", name: "Bolt", description: "", color: "#ffff00", damage: 10, damagePerLevel: 3,
 *     cooldown: 0.5, cooldownScalePerLevel: 0.9, maxLevel: 5,
 *     behavior: { kind: "bolt", projectileSpeed: 20, count: 1, countPerLevel: 0.5, pierce: 0, range: 14 },
 *   }],
 *   passives: [],
 *   waves: [{ from: 0, to: 60, enemy: "grunt", perSecond: 1 }],
 * });
 * Hero.make(content, "nobody", 0).def.id; // => "bolter"
 * ```
 *
 * @category constructors
 */
export const make = (
  content: GameContent.GameContent,
  heroId: string,
  slot: number
): Hero => {
  const def = content.heroes.find((h) => h.id === heroId) ?? content.heroes[0];
  // The content's Schema refuses a hero whose starting weapon isn't one of its weapons.
  const startingWeapon = content.weapons.find(
    (w) => w.id === def.startingWeapon
  )!;
  const [x, z] = START[slot] ?? START[0];
  return {
    slot,
    def,
    status: "playing",
    x,
    z,
    hp: def.maxHp,
    maxHp: def.maxHp,
    faceX: 0,
    faceZ: 1,
    hurtTimer: 0,
    stats: baseStats(content, def),
    weapons: [{ def: startingWeapon, level: 1, timer: 0.5, sinceFired: 99 }],
    passiveLevels: new Map(),
    offer: null,
    paused: false,
  };
};

const baseStats = (
  content: GameContent.GameContent,
  def: GameContent.HeroDef
): Stats => ({
  maxHpMult: 1,
  moveSpeed: def.moveSpeed * content.rules.baseMoveSpeedScale,
  damageMult: 1,
  cooldownMult: 1,
  areaMult: 1,
  pickupRadius: content.rules.basePickupRadius,
  regen: 0,
});

/** Recomputes a hero's stats from its passive levels. Called after every upgrade, never per frame. */
const recomputeStats = (content: GameContent.GameContent, hero: Hero): void => {
  const sum = {
    maxHp: 0,
    moveSpeed: 0,
    damage: 0,
    cooldown: 0,
    area: 0,
    pickupRadius: 0,
    regen: 0,
  };
  for (const passive of content.passives) {
    sum[passive.stat] +=
      passive.amountPerLevel * (hero.passiveLevels.get(passive.id) ?? 0);
  }
  const base = baseStats(content, hero.def);
  const previousMaxHp = hero.maxHp;
  hero.stats = {
    maxHpMult: 1 + sum.maxHp,
    moveSpeed: base.moveSpeed * (1 + sum.moveSpeed),
    damageMult: 1 + sum.damage,
    cooldownMult: 1 / (1 + sum.cooldown),
    areaMult: 1 + sum.area,
    pickupRadius: base.pickupRadius * (1 + sum.pickupRadius),
    regen: sum.regen,
  };
  hero.maxHp = hero.def.maxHp * hero.stats.maxHpMult;
  // Extra max HP arrives filled.
  hero.hp += Math.max(0, hero.maxHp - previousMaxHp);
};

/**
 * The damage one of a hero's weapons deals with each hit: its damage at its level, times the
 * hero's damage multiplier.
 *
 * **When to use**
 *
 * In the rules, as a bolt fires or an aura pulses, and in a test of a weapon's numbers.
 *
 * **Example** (A bolt at levels 1 and 3)
 *
 * ```ts
 * import { GameContent, Hero } from "#survivors";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(GameContent.GameContent)({
 *   rules: {
 *     arenaHalfSize: 20, maxEnemies: 50, xpToLevel2: 5, xpGrowth: 1.3,
 *     baseMoveSpeedScale: 1, basePickupRadius: 2.5, choicesPerLevelUp: 3, runLength: 60,
 *   },
 *   heroes: [{ id: "bolter", name: "Bolter", description: "", color: "#ffffff", maxHp: 100, moveSpeed: 6, startingWeapon: "bolt" }],
 *   enemies: [{ id: "grunt", name: "Grunt", color: "#00ff00", hp: 8, speed: 2.5, damage: 10, radius: 0.45, xp: 1 }],
 *   weapons: [{
 *     id: "bolt", name: "Bolt", description: "", color: "#ffff00", damage: 10, damagePerLevel: 3,
 *     cooldown: 0.5, cooldownScalePerLevel: 0.9, maxLevel: 5,
 *     behavior: { kind: "bolt", projectileSpeed: 20, count: 1, countPerLevel: 0.5, pierce: 0, range: 14 },
 *   }],
 *   passives: [],
 *   waves: [{ from: 0, to: 60, enemy: "grunt", perSecond: 1 }],
 * });
 * const hero = Hero.make(content, "bolter", 0);
 * const bolt = hero.weapons[0]!;
 * Hero.weaponDamage(hero, bolt); // => 10
 * bolt.level = 3;
 * Hero.weaponDamage(hero, bolt); // => 16
 * ```
 *
 * @category getters
 */
export const weaponDamage = (self: Hero, slot: WeaponSlot): number =>
  (slot.def.damage + slot.def.damagePerLevel * (slot.level - 1)) *
  self.stats.damageMult;

/**
 * The seconds between two attacks of one of a hero's weapons: its cooldown, scaled once per level
 * after the first, times the hero's cooldown multiplier.
 *
 * **When to use**
 *
 * In the rules, which start a weapon's timer from it after each attack.
 *
 * **Example** (A bolt at levels 1 and 2)
 *
 * ```ts
 * import { GameContent, Hero } from "#survivors";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(GameContent.GameContent)({
 *   rules: {
 *     arenaHalfSize: 20, maxEnemies: 50, xpToLevel2: 5, xpGrowth: 1.3,
 *     baseMoveSpeedScale: 1, basePickupRadius: 2.5, choicesPerLevelUp: 3, runLength: 60,
 *   },
 *   heroes: [{ id: "bolter", name: "Bolter", description: "", color: "#ffffff", maxHp: 100, moveSpeed: 6, startingWeapon: "bolt" }],
 *   enemies: [{ id: "grunt", name: "Grunt", color: "#00ff00", hp: 8, speed: 2.5, damage: 10, radius: 0.45, xp: 1 }],
 *   weapons: [{
 *     id: "bolt", name: "Bolt", description: "", color: "#ffff00", damage: 10, damagePerLevel: 3,
 *     cooldown: 0.5, cooldownScalePerLevel: 0.5, maxLevel: 5,
 *     behavior: { kind: "bolt", projectileSpeed: 20, count: 1, countPerLevel: 0.5, pierce: 0, range: 14 },
 *   }],
 *   passives: [],
 *   waves: [{ from: 0, to: 60, enemy: "grunt", perSecond: 1 }],
 * });
 * const hero = Hero.make(content, "bolter", 0);
 * const bolt = hero.weapons[0]!;
 * Hero.weaponCooldown(hero, bolt); // => 0.5
 * bolt.level = 2;
 * Hero.weaponCooldown(hero, bolt); // => 0.25
 * ```
 *
 * @category getters
 */
export const weaponCooldown = (self: Hero, slot: WeaponSlot): number =>
  slot.def.cooldown *
  ExactMath.powInt(slot.def.cooldownScalePerLevel, slot.level - 1) *
  self.stats.cooldownMult;

/**
 * The radius one of a hero's weapons damages around it, if it is an aura: its radius at its level,
 * times the hero's area multiplier. A bolt's is 0.
 *
 * **When to use**
 *
 * In the rules, as an aura pulses, and in a view that draws the aura's ring, so the ring is where
 * the rules hit.
 *
 * **Example** (An aura and a bolt)
 *
 * ```ts
 * import { GameContent, Hero } from "#survivors";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(GameContent.GameContent)({
 *   rules: {
 *     arenaHalfSize: 20, maxEnemies: 50, xpToLevel2: 5, xpGrowth: 1.3,
 *     baseMoveSpeedScale: 1, basePickupRadius: 2.5, choicesPerLevelUp: 3, runLength: 60,
 *   },
 *   heroes: [{ id: "burner", name: "Burner", description: "", color: "#ff0000", maxHp: 120, moveSpeed: 5, startingWeapon: "aura" }],
 *   enemies: [{ id: "grunt", name: "Grunt", color: "#00ff00", hp: 8, speed: 2.5, damage: 10, radius: 0.45, xp: 1 }],
 *   weapons: [
 *     {
 *       id: "aura", name: "Aura", description: "", color: "#ff8800", damage: 6, damagePerLevel: 2,
 *       cooldown: 0.5, cooldownScalePerLevel: 0.95, maxLevel: 5,
 *       behavior: { kind: "aura", radius: 2.5, radiusPerLevel: 0.5 },
 *     },
 *     {
 *       id: "bolt", name: "Bolt", description: "", color: "#ffff00", damage: 10, damagePerLevel: 3,
 *       cooldown: 0.5, cooldownScalePerLevel: 0.9, maxLevel: 5,
 *       behavior: { kind: "bolt", projectileSpeed: 20, count: 1, countPerLevel: 0.5, pierce: 0, range: 14 },
 *     },
 *   ],
 *   passives: [],
 *   waves: [{ from: 0, to: 60, enemy: "grunt", perSecond: 1 }],
 * });
 * const hero = Hero.make(content, "burner", 0);
 * Hero.upgrade(hero, content, { kind: "weapon", id: "bolt", name: "Bolt", description: "", level: 1 });
 * hero.weapons.map((slot) => Hero.auraRadius(hero, slot)); // => [2.5, 0]
 * ```
 *
 * @category getters
 */
export const auraRadius = (self: Hero, slot: WeaponSlot): number =>
  slot.def.behavior.kind === "aura"
    ? (slot.def.behavior.radius +
        slot.def.behavior.radiusPerLevel * (slot.level - 1)) *
      self.stats.areaMult
    : 0;

/**
 * Gives a hero the upgrade it chose from its offer: a weapon's next level or a new weapon, a
 * passive's next level, or a heal. It leaves the hero's offer as it is.
 *
 * **When to use**
 *
 * Rarely: a pick goes through `World.choose`, which takes the choice from the hero's offer, gives
 * it with this and closes the offer.
 *
 * **Details**
 *
 * A weapon choice sets that weapon's level to the choice's; a weapon the hero lacks joins at
 * level 1, its timer at 0, ready to attack. A passive choice sets the passive's level and works
 * the hero's stats out again, and max HP it adds arrives filled. A heal gives back 30% of max HP,
 * up to the max.
 *
 * **Example** (A bolt's second level)
 *
 * ```ts
 * import { GameContent, Hero } from "#survivors";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(GameContent.GameContent)({
 *   rules: {
 *     arenaHalfSize: 20, maxEnemies: 50, xpToLevel2: 5, xpGrowth: 1.3,
 *     baseMoveSpeedScale: 1, basePickupRadius: 2.5, choicesPerLevelUp: 3, runLength: 60,
 *   },
 *   heroes: [{ id: "bolter", name: "Bolter", description: "", color: "#ffffff", maxHp: 100, moveSpeed: 6, startingWeapon: "bolt" }],
 *   enemies: [{ id: "grunt", name: "Grunt", color: "#00ff00", hp: 8, speed: 2.5, damage: 10, radius: 0.45, xp: 1 }],
 *   weapons: [{
 *     id: "bolt", name: "Bolt", description: "", color: "#ffff00", damage: 10, damagePerLevel: 3,
 *     cooldown: 0.5, cooldownScalePerLevel: 0.9, maxLevel: 5,
 *     behavior: { kind: "bolt", projectileSpeed: 20, count: 1, countPerLevel: 0.5, pierce: 0, range: 14 },
 *   }],
 *   passives: [],
 *   waves: [{ from: 0, to: 60, enemy: "grunt", perSecond: 1 }],
 * });
 * const hero = Hero.make(content, "bolter", 0);
 * Hero.upgrade(hero, content, { kind: "weapon", id: "bolt", name: "Bolt", description: "", level: 2 });
 * Hero.weaponDamage(hero, hero.weapons[0]!); // => 13
 * ```
 *
 * @category mutations
 */
export const upgrade = (
  self: Hero,
  content: GameContent.GameContent,
  choice: Offer.Choice
): void => {
  if (choice.kind === "weapon") {
    const slot = self.weapons.find((s) => s.def.id === choice.id);
    if (slot) {
      slot.level = choice.level;
    } else {
      // An offer only names a weapon of the content.
      const def = content.weapons.find((w) => w.id === choice.id)!;
      self.weapons.push({ def, level: 1, timer: 0, sinceFired: 99 });
    }
  } else if (choice.kind === "passive") {
    self.passiveLevels.set(choice.id, choice.level);
    recomputeStats(content, self);
  } else {
    self.hp = Math.min(self.maxHp, self.hp + self.maxHp * 0.3);
  }
};
