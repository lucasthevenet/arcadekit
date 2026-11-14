/**
 * Survivors' content, declared: the rules, heroes, enemies, weapons, passives and waves, and the
 * file each comes from.
 *
 * The app provides it from its content source, and a run's config holds what it loads; a co-op
 * run loads it on every peer, which compare its hash. The Schema it decodes with (`GameContent`)
 * checks that every reference names something that exists.
 */
import { Content } from "arcadekit/content";

import * as GameContent from "./game-content";

/**
 * A survivors game's content: the content Schema, which also checks that every reference names
 * something that exists, and the six files it comes from (`rules.json`, `heroes.json`,
 * `enemies.json`, `weapons.json`, `passives.json`, `waves.json`).
 *
 * **When to use**
 *
 * In an app, to load the content: provide it with `SurvivorsContent.layer(source)` and load it
 * with `SurvivorsContent.load`, on the loading screen. `SurvivorsCoop` loads it too, on every
 * peer. In a test of a game's real files, `SurvivorsContent.read(source)` runs the same checks
 * and keeps nothing.
 *
 * **Details**
 *
 * The first successful load is kept, and a failed one can be run again. A file that fails to
 * decode, or a reference to nothing, fails the load with a `ContentSource.ContentError` that
 * names it.
 *
 * **Example** (Reading a game's content)
 *
 * ```ts
 * import { SurvivorsContent } from "../survivors/index";
 * import { ContentSource } from "arcadekit/content";
 * import { Effect } from "effect";
 *
 * const source = ContentSource.fromRecord({
 *   "rules.json": {
 *     arenaHalfSize: 20, maxEnemies: 50, xpToLevel2: 5, xpGrowth: 1.3,
 *     baseMoveSpeedScale: 1, basePickupRadius: 2.5, choicesPerLevelUp: 3, runLength: 60,
 *   },
 *   "heroes.json": [{ id: "bolter", name: "Bolter", description: "", color: "#ffffff", maxHp: 100, moveSpeed: 6, startingWeapon: "bolt" }],
 *   "enemies.json": [{ id: "grunt", name: "Grunt", color: "#00ff00", hp: 8, speed: 2.5, damage: 10, radius: 0.45, xp: 1 }],
 *   "weapons.json": [{
 *     id: "bolt", name: "Bolt", description: "", color: "#ffff00", damage: 10, damagePerLevel: 3,
 *     cooldown: 0.5, cooldownScalePerLevel: 0.9, maxLevel: 5,
 *     behavior: { kind: "bolt", projectileSpeed: 20, count: 1, countPerLevel: 0.5, pierce: 0, range: 14 },
 *   }],
 *   "passives.json": [],
 *   "waves.json": [{ from: 0, to: 60, enemy: "grunt", perSecond: 1 }],
 * });
 * const content = Effect.runSync(SurvivorsContent.read(source));
 * content.heroes[0].name; // => "Bolter"
 * ```
 *
 * @category declarations
 */
export class SurvivorsContent extends Content("SurvivorsContent", {
  schema: GameContent.GameContent,
  // Paths are relative to the content source.
  files: {
    rules: "rules.json",
    heroes: "heroes.json",
    enemies: "enemies.json",
    weapons: "weapons.json",
    passives: "passives.json",
    waves: "waves.json",
  },
}) {}
