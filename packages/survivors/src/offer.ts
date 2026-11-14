/**
 * Offers: the upgrade choices a survivors hero picks from after a level-up.
 *
 * Every playing hero gets an offer of its own on each level-up, rolled from what it can still
 * take: a weapon's next level, a new weapon while it has room, or a passive's next level, or a
 * heal when nothing is left. A pick answers it (`ChooseUpgrade`), and the run is frozen while any
 * hero's offer is open. `LeveledUp` carries the choices to the app.
 *
 * Plain on purpose: a step rolls an offer with the run's seeded `Rng`, so an offer gives the same
 * bits on every peer and every replay, and finishes in the call.
 */
import { Rng } from "arcadekit/core";
import { Schema } from "effect";

import type * as GameContent from "./game-content";
import * as Hero from "./hero";

/**
 * One upgrade a hero can pick, as a Schema: a weapon, a passive or a heal, with the level the
 * item reaches if picked.
 *
 * **When to use**
 *
 * In an app's Model and Messages, to show a hero's offer: `LeveledUp` carries its choices.
 *
 * **Details**
 *
 * `id` is the weapon's or the passive's id in the content, and `heal` for the heal, which is
 * offered alone when a hero can take nothing else.
 *
 * **Example** (Checking a choice)
 *
 * ```ts
 * import { Offer } from "@arcadekit/survivors";
 * import { Schema } from "effect";
 *
 * const choice = { kind: "passive", id: "power", name: "Power", description: "+10% damage", level: 2 };
 * Schema.is(Offer.Choice)(choice); // => true
 * Schema.is(Offer.Choice)({ ...choice, kind: "skin" }); // => false
 * ```
 *
 * @category schemas
 */
export const Choice = Schema.Struct({
  kind: Schema.Literals(["weapon", "passive", "heal"]),
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  /** Level the item reaches if picked. */
  level: Schema.Int,
});

/**
 * One upgrade a hero can pick.
 *
 * **When to use**
 *
 * To type a choice an app shows, or one a test hands `Hero.upgrade`.
 *
 * **Example** (Describing a choice)
 *
 * ```ts
 * import type { Offer } from "@arcadekit/survivors";
 *
 * const label = (choice: Offer.Choice) =>
 *   choice.kind === "heal" ? choice.name : `${choice.name} ${choice.level}`;
 * label({ kind: "weapon", id: "bolt", name: "Bolt", description: "", level: 2 }); // => "Bolt 2"
 * ```
 *
 * @category models
 */
export type Choice = typeof Choice.Type;

/**
 * A hero's offer: the choices it picks one of, in the order the roll drew them.
 *
 * **When to use**
 *
 * To read a hero's open offer (`Hero.Hero`'s `offer`), whose index a pick names.
 *
 * **Example** (The index of a heal)
 *
 * ```ts
 * import type { Offer } from "@arcadekit/survivors";
 *
 * const offer: Offer.Offer = [
 *   { kind: "weapon", id: "bolt", name: "Bolt", description: "", level: 2 },
 *   { kind: "heal", id: "heal", name: "Snack", description: "", level: 1 },
 * ];
 * offer.findIndex((choice) => choice.kind === "heal"); // => 1
 * ```
 *
 * @category models
 */
export type Offer = readonly Choice[];

/**
 * Rolls a hero's offer: up to the rules' `choicesPerLevelUp` of what the hero can still take,
 * drawn with the run's `rng`. With nothing left to take, the offer is one heal.
 *
 * **When to use**
 *
 * Rarely: a step rolls one for each playing hero on a level-up, and a test of the roll calls it
 * with a run's `Rng`.
 *
 * **Details**
 *
 * A hero can take a weapon's next level below its `maxLevel`, a weapon it lacks while it carries
 * fewer than `Hero.maxWeapons`, and a passive's next level below its `maxLevel`. The candidates
 * are listed in the content's order, weapons first, and drawn without repeats, so the same `Rng`
 * state rolls the same offer.
 *
 * **Example** (A hero whose bolt is at its last level)
 *
 * ```ts
 * import { GameContent, Hero, Offer } from "@arcadekit/survivors";
 * import { Rng } from "arcadekit/core";
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
 *     cooldown: 0.5, cooldownScalePerLevel: 0.9, maxLevel: 2,
 *     behavior: { kind: "bolt", projectileSpeed: 20, count: 1, countPerLevel: 0.5, pierce: 0, range: 14 },
 *   }],
 *   passives: [],
 *   waves: [{ from: 0, to: 60, enemy: "grunt", perSecond: 1 }],
 * });
 * const hero = Hero.make(content, "bolter", 0);
 * Offer.roll(content, Rng.make(1), hero).map((choice) => choice.id); // => ["bolt"]
 * hero.weapons[0]!.level = 2;
 * Offer.roll(content, Rng.make(1), hero).map((choice) => choice.id); // => ["heal"]
 * ```
 *
 * @category constructors
 */
export const roll = (
  content: GameContent.GameContent,
  rng: Rng.Rng,
  hero: Hero.Hero
): Offer => {
  const candidates: Choice[] = [];
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
    } else if (!slot && hero.weapons.length < Hero.maxWeapons) {
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
  const count = Rng.pickDistinct(
    rng,
    candidates,
    content.rules.choicesPerLevelUp
  );
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
