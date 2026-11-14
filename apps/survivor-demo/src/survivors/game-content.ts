/**
 * Survivors' content as a Schema: the rules of a run, the heroes, the enemies, the weapons, the
 * passive upgrades and the wave schedule.
 *
 * Everything a survivors game is made of is data, in JSON files the app ships. This Schema is
 * their contract: a game's content is decoded and checked once, when it loads, and a run trusts
 * it afterwards. Decoding refuses a reference to something that doesn't exist (a hero's starting
 * weapon, a wave's enemy), and names it, so the rules never look one up and miss.
 * `SurvivorsContent` loads the files with this Schema.
 *
 * Plain on purpose: the reference check is a plain function the Schema calls, pure data work.
 */
import { Schema } from "effect";

const Id = Schema.String.check(Schema.isNonEmpty());
const Positive = Schema.Finite.check(Schema.isGreaterThan(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const HexColor = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/u));

/** Hero stats that passive upgrades can raise. */
const StatKey = Schema.Literals([
  "maxHp",
  "moveSpeed",
  "damage",
  "cooldown",
  "area",
  "pickupRadius",
  "regen",
]);

const HeroDef = Schema.Struct({
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

/**
 * One hero of a game's content, decoded: its name, colour, hit points and speed, the weapon it
 * starts with, and the prefix of its tags in the app's sheet.
 *
 * **When to use**
 *
 * To read a hero's definition, as a run's hero keeps it (`Hero.Hero`'s `def`) and an app lists
 * the heroes to pick from.
 *
 * **Details**
 *
 * `sprite` names the prefix of its `walk`, `idle` and `down` tags in the app's sheet. Without
 * one, the view draws the generic hero tinted with `color`; where the sheet lacks one of the
 * three, the view draws the generic one in its place, and tints the hero with `color`.
 *
 * **Example** (A hero's name and starting weapon)
 *
 * ```ts
 * import type { GameContent } from "../survivors/index";
 *
 * const knight: GameContent.HeroDef = {
 *   id: "knight",
 *   name: "Knight",
 *   description: "Slow and sturdy.",
 *   color: "#c0c0c0",
 *   maxHp: 150,
 *   moveSpeed: 4,
 *   startingWeapon: "bolt",
 *   sprite: "knight",
 * };
 * `${knight.name} starts with ${knight.startingWeapon}`; // => "Knight starts with bolt"
 * ```
 *
 * @category models
 */
export type HeroDef = typeof HeroDef.Type;

const EnemyDef = Schema.Struct({
  id: Id,
  name: Schema.String,
  color: HexColor,
  hp: Positive,
  speed: Positive,
  /** Damage per second while touching a hero. */
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

/**
 * One enemy of a game's content, decoded: its hit points, speed, size, the damage it deals a
 * hero it touches each second, the XP it drops, and its animation in the app's sheet.
 *
 * **When to use**
 *
 * To read an enemy's definition: a run keeps the content's enemies in order (`World.Arena`'s
 * `enemyDefs`), and an enemy's `type` in the pool is its index there.
 *
 * **Example** (An enemy that drops no XP)
 *
 * ```ts
 * import type { GameContent } from "../survivors/index";
 *
 * const bat: GameContent.EnemyDef = {
 *   id: "bat",
 *   name: "Bat",
 *   color: "#663399",
 *   hp: 4,
 *   speed: 4,
 *   damage: 5,
 *   radius: 0.3,
 *   xp: 0,
 *   sprite: "bat/move",
 * };
 * bat.damage * 2; // => 10
 * ```
 *
 * @category models
 */
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

/** Damages every enemy within a radius around the hero. */
const AuraWeapon = Schema.Struct({
  kind: Schema.Literal("aura"),
  radius: Positive,
  radiusPerLevel: NonNegative,
});

const WeaponDef = Schema.Struct({
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

/**
 * One weapon of a game's content, decoded: its damage and cooldown and how each changes per
 * level, its most levels, and how it attacks, a `bolt` that fires at the nearest enemies or an
 * `aura` that damages every enemy around its hero.
 *
 * **When to use**
 *
 * To read a weapon's definition, as a hero's weapon slot keeps it (`Hero.WeaponSlot`'s `def`).
 *
 * **Details**
 *
 * `sound` names a bolt's shot in the app's sound list, played in place of the cue table's `shot`.
 * `sprite` names a bolt's projectile in the app's sheet; without it, the generic projectile is
 * tinted with `color`. A projectile's trail and an aura's ring always take `color`.
 *
 * **Example** (An aura's reach)
 *
 * ```ts
 * import type { GameContent } from "../survivors/index";
 *
 * const aura: GameContent.WeaponDef = {
 *   id: "aura",
 *   name: "Aura",
 *   description: "Burns what comes close.",
 *   color: "#ff8800",
 *   damage: 6,
 *   damagePerLevel: 2,
 *   cooldown: 0.5,
 *   cooldownScalePerLevel: 0.95,
 *   maxLevel: 5,
 *   behavior: { kind: "aura", radius: 2.5, radiusPerLevel: 0.5 },
 * };
 * aura.behavior.kind === "aura" ? aura.behavior.radius : 0; // => 2.5
 * ```
 *
 * @category models
 */
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
  /** How many upgrades a level-up offers. A whole number: the roll draws once for each. */
  choicesPerLevelUp: PositiveInt,
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

/**
 * A survivors game's content, as a Schema: its rules, and one or more heroes, enemies, weapons
 * and waves, and its passive upgrades.
 *
 * **When to use**
 *
 * To decode content a test writes in place, or to check content without loading it. A game loads
 * its files with `SurvivorsContent`, which decodes with this Schema.
 *
 * **Details**
 *
 * Decoding refuses a hero whose starting weapon isn't one of the weapons, and a wave whose enemy
 * isn't one of the enemies, and names them: `hero "knight" starts with unknown weapon "sword"`.
 * A colour is `#rrggbb`; the enemy pool's size and the choices per level-up are whole numbers.
 *
 * **Example** (Decoding a game, and refusing a hero with a weapon it lacks)
 *
 * ```ts
 * import { GameContent } from "../survivors/index";
 * import { Schema } from "effect";
 *
 * const game = {
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
 * };
 * Schema.decodeUnknownSync(GameContent.GameContent)(game).heroes[0].name; // => "Bolter"
 * const swordless = { ...game, heroes: [{ ...game.heroes[0], startingWeapon: "sword" }] };
 * Schema.is(GameContent.GameContent)(swordless); // => false
 * ```
 *
 * @category schemas
 */
export const GameContent = Schema.Struct({
  rules: Rules,
  heroes: Schema.NonEmptyArray(HeroDef),
  enemies: Schema.NonEmptyArray(EnemyDef),
  weapons: Schema.NonEmptyArray(WeaponDef),
  passives: Schema.Array(PassiveDef),
  waves: Schema.NonEmptyArray(WaveDef),
}).check(
  // Ids are checked here, not left to a loader, so the rules can trust content however it was decoded.
  Schema.makeFilter(brokenReferences)
);

/**
 * A survivors game's content, decoded: what a run's config holds.
 *
 * **When to use**
 *
 * To type the content a run starts from, as `World.Config` does, or the heroes an app lists for
 * a player to pick.
 *
 * **Example** (The heroes a player picks from)
 *
 * ```ts
 * import { GameContent } from "../survivors/index";
 * import { Schema } from "effect";
 *
 * const content: GameContent.GameContent = Schema.decodeUnknownSync(GameContent.GameContent)({
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
 * content.heroes.map((hero) => hero.name); // => ["Bolter"]
 * ```
 *
 * @category models
 */
export type GameContent = typeof GameContent.Type;
