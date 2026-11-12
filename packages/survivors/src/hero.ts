import { powInt } from "arcadekit/core";
import type { Rng } from "arcadekit/core";

import type { UpgradeChoice } from "./events";
import type { GameContent, HeroDef, WeaponDef } from "./schema";

// What each player owns in a survivors run: a hero's body, stats, weapons, passives and the
// upgrade offer it is choosing from. Everything shared (the clock, team XP, the horde, gems,
// projectiles, the Rng) is in world.ts. Plain data and plain functions, like the rest of the step.

/** The most heroes a run holds: one per player, 2 to 4 players in co-op. */
export const MAX_HEROES = 4;
/** The most weapons one hero carries. */
export const MAX_WEAPONS = 4;

export interface WeaponSlot {
  readonly def: WeaponDef;
  level: number;
  /** Seconds until the next attack. */
  timer: number;
  /** Seconds since the last attack; the view uses it for attack flashes. */
  sinceFired: number;
}

interface Stats {
  maxHpMult: number;
  moveSpeed: number;
  damageMult: number;
  cooldownMult: number;
  areaMult: number;
  pickupRadius: number;
  regen: number;
}

/**
 * - `playing`: in the run: moves, fights, collects gems, is chased and gets upgrade offers.
 * - `down`: out of hit points. It stays where it fell and does nothing; nothing revives it.
 * - `left`: its player left the run (lockstep removed them). The view no longer draws it.
 *
 * The run is lost once no hero is `playing`.
 */
type HeroStatus = "playing" | "down" | "left";

/** One player's hero. Its index in `World.heroes` is its slot, the player's place in player order. */
export interface Hero {
  readonly slot: number;
  readonly def: HeroDef;
  status: HeroStatus;
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  faceX: number;
  faceZ: number;
  hurtTimer: number;
  stats: Stats;
  readonly weapons: WeaponSlot[];
  readonly passiveLevels: Map<string, number>;
  /** The upgrades this hero is choosing from, or null. The whole run is frozen while any hero has one. */
  offer: readonly UpgradeChoice[] | null;
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

/** Makes the hero for `slot`. An unknown hero id falls back to the content's first hero. */
export const createHero = (
  content: GameContent,
  heroId: string,
  slot: number
): Hero => {
  const def = content.heroes.find((h) => h.id === heroId) ?? content.heroes[0];
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

const baseStats = (content: GameContent, def: HeroDef): Stats => ({
  maxHpMult: 1,
  moveSpeed: def.moveSpeed * content.rules.baseMoveSpeedScale,
  damageMult: 1,
  cooldownMult: 1,
  areaMult: 1,
  pickupRadius: content.rules.basePickupRadius,
  regen: 0,
});

/** Recomputes a hero's stats from its passive levels. Called after every upgrade, never per frame. */
const recomputeStats = (content: GameContent, hero: Hero): void => {
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

// ---------------------------------------------------------------------------
// Weapon numbers the rules use. The view draws the aura with `auraRadius`, so it matches the rules.

export const weaponDamage = (hero: Hero, slot: WeaponSlot): number =>
  (slot.def.damage + slot.def.damagePerLevel * (slot.level - 1)) *
  hero.stats.damageMult;

export const weaponCooldown = (hero: Hero, slot: WeaponSlot): number =>
  slot.def.cooldown *
  powInt(slot.def.cooldownScalePerLevel, slot.level - 1) *
  hero.stats.cooldownMult;

export const auraRadius = (hero: Hero, slot: WeaponSlot): number =>
  slot.def.behavior.kind === "aura"
    ? (slot.def.behavior.radius +
        slot.def.behavior.radiusPerLevel * (slot.level - 1)) *
      hero.stats.areaMult
    : 0;

// ---------------------------------------------------------------------------
// Upgrades

/** Rolls a hero's upgrade offer from what it can still take, with the run's seeded Rng. */
export const rollUpgrades = (
  content: GameContent,
  rng: Rng,
  hero: Hero
): readonly UpgradeChoice[] => {
  const candidates: UpgradeChoice[] = [];
  for (const def of content.weapons) {
    const slot = hero.weapons.find((s) => s.def.id === def.id);
    if (slot && slot.level < def.maxLevel) {
      candidates.push({
        kind: "weapon",
        id: def.id,
        name: def.name,
        description: "Stronger and faster.",
        level: slot.level + 1,
      });
    } else if (!slot && hero.weapons.length < MAX_WEAPONS) {
      candidates.push({
        kind: "weapon",
        id: def.id,
        name: def.name,
        description: def.description,
        level: 1,
      });
    }
  }
  for (const def of content.passives) {
    const level = hero.passiveLevels.get(def.id) ?? 0;
    if (level < def.maxLevel) {
      candidates.push({
        kind: "passive",
        id: def.id,
        name: def.name,
        description: def.description,
        level: level + 1,
      });
    }
  }
  // Drawn with the run's seeded Rng, so runs stay reproducible.
  const count = rng.pickDistinct(candidates, content.rules.choicesPerLevelUp);
  const picks = candidates.slice(0, count);
  return picks.length > 0
    ? picks
    : [
        {
          kind: "heal",
          id: "heal",
          name: "Snack",
          description: "Restore 30% of your HP.",
          level: 1,
        },
      ];
};

/** Gives a hero the upgrade it chose. Doesn't touch its offer; world.ts closes that. */
export const applyChoice = (
  content: GameContent,
  hero: Hero,
  choice: UpgradeChoice
): void => {
  if (choice.kind === "weapon") {
    const slot = hero.weapons.find((s) => s.def.id === choice.id);
    if (slot) {
      slot.level = choice.level;
    } else {
      const def = content.weapons.find((w) => w.id === choice.id)!;
      hero.weapons.push({ def, level: 1, timer: 0, sinceFired: 99 });
    }
  } else if (choice.kind === "passive") {
    hero.passiveLevels.set(choice.id, choice.level);
    recomputeStats(content, hero);
  } else {
    hero.hp = Math.min(hero.maxHp, hero.hp + hero.maxHp * 0.3);
  }
};
