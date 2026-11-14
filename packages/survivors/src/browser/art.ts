/**
 * Survivors' art: the tags its view draws from the app's sprite sheet, and how many of the
 * sheet's pixels make one world unit.
 *
 * The genre ships no art. The app's sheet (`SurvivorsSheet`) has a tag for each thing the view
 * draws: the ground and the arena's wall, gems, shadows, markers, the aura's ring and the
 * projectiles' trails, and for each of the content's heroes, enemies and weapons the `sprite` it
 * names or a generic one the view tints with its `color`. Which tags those are depends on the
 * content, so the app's test checks its sheet against `tags(content)`.
 *
 * Plain on purpose: it is data, which the view reads when it is made and once per run.
 */
import type { SpriteSheet } from "arcadekit/render-three";

import type * as GameContent from "../game-content";
import * as SpriteTags from "./internal/sprite-tags";

/**
 * Every tag the view draws for `content`, by the name it reads each under, with the tags it draws
 * in its place when the sheet lacks it.
 *
 * **When to use**
 *
 * In an app's test, to check its sheet against its content:
 * `SpriteSheet.resolveTags(sheet.data, Art.tags(content)).missing` lists what the sheet lacks.
 *
 * **Details**
 *
 * A content entry's `sprite` comes first, then the generic tag the view tints with the entry's
 * `color`: a hero's `hero/walk`, `hero/idle` and `hero/down`, an enemy's `enemy/move`, and a
 * weapon's projectile `bolt/generic`. A generic tag is asked of the sheet only for an entry that names no sprite, or
 * one the sheet lacks, so a test that wants them all checks a content that names none as well. A
 * name the sheet has none of draws frame 0.
 *
 * **Example** (A sheet without a hero's own tags)
 *
 * ```ts
 * import { GameContent } from "@arcadekit/survivors";
 * import { Art } from "@arcadekit/survivors/browser";
 * import { SpriteSheet } from "arcadekit/render-three";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(GameContent.GameContent)({
 *   rules: {
 *     arenaHalfSize: 20, maxEnemies: 50, xpToLevel2: 5, xpGrowth: 1.3,
 *     baseMoveSpeedScale: 1, basePickupRadius: 2.5, choicesPerLevelUp: 3, runLength: 60,
 *   },
 *   heroes: [{ id: "knight", name: "Knight", description: "", color: "#c0c0c0", maxHp: 150, moveSpeed: 4, startingWeapon: "bolt", sprite: "knight" }],
 *   enemies: [{ id: "grunt", name: "Grunt", color: "#00ff00", hp: 8, speed: 2.5, damage: 10, radius: 0.45, xp: 1 }],
 *   weapons: [{
 *     id: "bolt", name: "Bolt", description: "", color: "#ffff00", damage: 10, damagePerLevel: 3,
 *     cooldown: 0.5, cooldownScalePerLevel: 0.9, maxLevel: 5,
 *     behavior: { kind: "bolt", projectileSpeed: 20, count: 1, countPerLevel: 0.5, pierce: 0, range: 14 },
 *   }],
 *   passives: [],
 *   waves: [{ from: 0, to: 60, enemy: "grunt", perSecond: 1 }],
 * });
 * const { data } = TestSpriteSheet.fromTags({
 *   "hero/walk": 4, "hero/idle": 1, "hero/down": 1, "enemy/move": 2, "bolt/generic": 2,
 *   trail: 3, "gem/small": 1, "gem/medium": 1, "gem/large": 1, "aura/ring": 2,
 *   "marker/ring": 1, shadow: 1, "ground/grass": 4, "ground/patch": 3, "edge/void": 2,
 *   "edge/n": 1, "edge/e": 1, "edge/s": 1, "edge/w": 1,
 *   "edge/nw": 1, "edge/ne": 1, "edge/se": 1, "edge/sw": 1,
 * });
 * // Warns once that the sheet has no tags "knight/walk", "knight/idle" and "knight/down".
 * SpriteSheet.resolveTags(data, Art.tags(content)).missing; // => ["knight/walk", "knight/idle", "knight/down"]
 * ```
 *
 * @category getters
 */
export const tags = (
  content: GameContent.GameContent
): SpriteSheet.WantedTags => ({
  ...SpriteTags.scene,
  ...SpriteTags.forContent(content),
});

/**
 * The sheet's pixels in one world unit: a tile of the ground is 16 pixels square, and one unit.
 *
 * **When to use**
 *
 * To size the app's art: a hero's frame is 24 pixels tall and an enemy's 16, so a hero is a unit
 * and a half and an enemy one.
 *
 * **Example** (The size of a tile)
 *
 * ```ts
 * import { Art } from "@arcadekit/survivors/browser";
 *
 * Art.pixelsPerUnit; // => 16
 * ```
 *
 * @category models
 */
export const pixelsPerUnit = 16;
