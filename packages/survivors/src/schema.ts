import { Schema } from "effect";

// Everything a game is made of lives in JSON files under public/content.
// These schemas are the contract: content is decoded and checked once at boot,
// and the simulation can trust it afterwards.

const Id = Schema.String.check(Schema.isNonEmpty());
const Positive = Schema.Finite.check(Schema.isGreaterThan(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const HexColor = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/u));

/** Player stats that passive upgrades can raise. */
const StatKey = Schema.Literals([
  "maxHp",
  "moveSpeed",
  "damage",
  "cooldown",
  "area",
  "pickupRadius",
  "regen",
]);

export const HeroDef = Schema.Struct({
  id: Id,
  name: Schema.String,
  description: Schema.String,
  color: HexColor,
  maxHp: Positive,
  moveSpeed: Positive,
  startingWeapon: Id,
  /**
   * The prefix of this hero's tags in the app's sprite sheet: `<sprite>/walk`, `<sprite>/idle`
   * and `<sprite>/down`. Without one, or if the sheet lacks them, a generic hero is drawn in `color`.
   */
  sprite: Schema.optional(Schema.String),
});
export type HeroDef = typeof HeroDef.Type;

export const EnemyDef = Schema.Struct({
  id: Id,
  name: Schema.String,
  color: HexColor,
  hp: Positive,
  speed: Positive,
  /** Damage per second while touching the player. */
  damage: NonNegative,
  radius: Positive,
  /** XP dropped on death. */
  xp: NonNegative,
  /**
   * This enemy's animation, a tag in the app's sprite sheet (`slime/move`). Without one, or if
   * the sheet lacks it, a generic enemy is drawn in `color`.
   */
  sprite: Schema.optional(Schema.String),
});
export type EnemyDef = typeof EnemyDef.Type;

/** Fires projectiles at the nearest enemies. */
const BoltWeapon = Schema.Struct({
  kind: Schema.Literal("bolt"),
  projectileSpeed: Positive,
  /** Projectiles per volley at level 1. */
  count: Positive,
  countPerLevel: NonNegative,
  /** How many enemies one projectile can pass through. */
  pierce: NonNegative,
  range: Positive,
});

/** Damages every enemy within a radius around the player. */
const AuraWeapon = Schema.Struct({
  kind: Schema.Literal("aura"),
  radius: Positive,
  radiusPerLevel: NonNegative,
});

export const WeaponDef = Schema.Struct({
  id: Id,
  name: Schema.String,
  description: Schema.String,
  color: HexColor,
  damage: Positive,
  damagePerLevel: NonNegative,
  /** Seconds between attacks at level 1. */
  cooldown: Positive,
  /** Multiplier applied to the cooldown per level after the first (0.9 = 10% faster). */
  cooldownScalePerLevel: Positive,
  maxLevel: Positive,
  behavior: Schema.Union([BoltWeapon, AuraWeapon]),
  /** The id of this weapon's shot sound in the app's sound list. Without one, a bolt plays the app's default shot. The aura fires no shots. */
  sound: Schema.optional(Schema.String),
  /**
   * A bolt's projectile, a tag in the app's sprite sheet (`bolt/arc`). Without one, or if the
   * sheet lacks it, a generic projectile is drawn in `color`. The aura is drawn in `color`.
   */
  sprite: Schema.optional(Schema.String),
});
export type WeaponDef = typeof WeaponDef.Type;

const PassiveDef = Schema.Struct({
  id: Id,
  name: Schema.String,
  description: Schema.String,
  stat: StatKey,
  /** Added per level, as a fraction for multipliers (0.1 = +10%) or a flat value for regen. */
  amountPerLevel: Schema.Finite,
  maxLevel: Positive,
});

/** One line of the spawn schedule: while `from <= time < to`, spawn this enemy. */
const WaveDef = Schema.Struct({
  from: NonNegative,
  to: Positive,
  enemy: Id,
  perSecond: Positive,
});

const Rules = Schema.Struct({
  arenaHalfSize: Positive,
  /** The enemy pool's size. A whole number: the pool's typed arrays are allocated from it. */
  maxEnemies: PositiveInt,
  xpToLevel2: Positive,
  xpGrowth: Positive,
  baseMoveSpeedScale: Positive,
  basePickupRadius: Positive,
  choicesPerLevelUp: Positive,
  /** Seconds to survive to win the run. */
  runLength: Positive,
});

/** Finds ids that point at nothing (a hero's starting weapon, a wave's enemy). */
const brokenReferences = (content: {
  readonly heroes: readonly HeroDef[];
  readonly enemies: readonly EnemyDef[];
  readonly weapons: readonly WeaponDef[];
  readonly waves: readonly (typeof WaveDef.Type)[];
}): readonly string[] => {
  const weaponIds = new Set(content.weapons.map((w) => w.id));
  const enemyIds = new Set(content.enemies.map((e) => e.id));
  return [
    ...content.heroes
      .filter((h) => !weaponIds.has(h.startingWeapon))
      .map(
        (h) => `hero "${h.id}" starts with unknown weapon "${h.startingWeapon}"`
      ),
    ...content.waves
      .filter((w) => !enemyIds.has(w.enemy))
      .map((w) => `wave ${w.from}-${w.to}s spawns unknown enemy "${w.enemy}"`),
  ];
};

export const GameContent = Schema.Struct({
  rules: Rules,
  heroes: Schema.NonEmptyArray(HeroDef),
  enemies: Schema.NonEmptyArray(EnemyDef),
  weapons: Schema.NonEmptyArray(WeaponDef),
  passives: Schema.Array(PassiveDef),
  waves: Schema.NonEmptyArray(WaveDef),
}).check(
  // Ids are checked here, not left to a loader, so the world can trust content however it was decoded.
  Schema.makeFilter(brokenReferences)
);
export type GameContent = typeof GameContent.Type;
