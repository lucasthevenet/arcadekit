/**
 * The sheet's tags the arena's sprites draw: the generic ones, the ones every run draws, and the
 * ones a content's heroes, enemies and weapons name, each with the tags it falls back to.
 *
 * Generic art is white and grey, and tinted: a hero, an enemy or a projectile drawn from it with
 * its content's `color`. A trail and an aura's ring always take their weapon's colour, and a
 * hero's marker its slot's. The sprites resolve `scene` once, when they are made, and
 * `forContent` once per run; `Art.tags` puts the two together for an app's test of its sheet.
 *
 * Plain on purpose: it is data, and a function of a content the sprites call once per run.
 */
import type { SpriteSheet } from "arcadekit/render-three";

import type * as GameContent from "../../game-content";

/**
 * The tags drawn when content names no `sprite`, or one the sheet lacks, and the tags always
 * drawn, as the app's sheet names them.
 */
export const generic = {
  /** A hero's tags are `<prefix>/walk`, `<prefix>/idle` and `<prefix>/down`. */
  hero: "hero",
  enemy: "enemy/move",
  bolt: "bolt/generic",
  /** Fresh to faded: a trail puff's frame is picked by its age. */
  trail: "trail",
  /** Small, medium and large: gems worth 1, up to 3, and more. */
  gems: ["gem/small", "gem/medium", "gem/large"],
  /** White, drawn at the aura's radius in whole pixels; frame 1 is the ring dealing damage. */
  aura: "aura/ring",
  marker: "marker/ring",
  shadow: "shadow",
  grass: "ground/grass",
  patch: "ground/patch",
  /** The arena wall, by the side of the arena it sits on. */
  edges: {
    n: "edge/n",
    e: "edge/e",
    s: "edge/s",
    w: "edge/w",
    nw: "edge/nw",
    ne: "edge/ne",
    se: "edge/se",
    sw: "edge/sw",
  },
  /** The dark drop beyond the wall. */
  void: "edge/void",
} as const;

/** The three tags a hero draws from its `sprite` prefix, or the generic `hero`. */
export const forHero = (prefix: string) =>
  ({
    walk: `${prefix}/walk`,
    idle: `${prefix}/idle`,
    down: `${prefix}/down`,
  }) as const;

/** The tags drawn whatever the content, by the name the sprites read each under. */
export const scene = {
  bolt: generic.bolt,
  trail: generic.trail,
  gemSmall: generic.gems[0],
  gemMedium: generic.gems[1],
  gemLarge: generic.gems[2],
  aura: generic.aura,
  marker: generic.marker,
  shadow: generic.shadow,
  grass: generic.grass,
  patch: generic.patch,
  void: generic.void,
  ...generic.edges,
} as const;

/**
 * The names `forContent` gives the tags of a content's heroes, enemies and weapons: a hero's and
 * a weapon's by id, as the rules find them, and an enemy's by its place in the content's
 * `enemies`, which is its type in a run.
 */
export const names = {
  hero: (id: string, part: keyof ReturnType<typeof forHero>) =>
    `hero ${id} ${part}`,
  enemy: (type: number) => `enemy ${type}`,
  weapon: (id: string) => `weapon ${id}`,
} as const;

/**
 * The tags drawn for a content's heroes, enemies and weapons, by their `names`, each with what is
 * drawn in its place: the `sprite` the content names, then the generic one, which the sprites
 * tint with the entry's `color`. Of two entries with one id, the first is drawn, as the rules play
 * the first.
 */
export const forContent = (
  content: GameContent.GameContent
): SpriteSheet.WantedTags => {
  const wanted: Record<string, readonly (string | undefined)[]> = {};
  const heroGeneric = forHero(generic.hero);
  // Of two entries with one id, the rules play the first: so does the view.
  for (const hero of content.heroes) {
    const own = hero.sprite === undefined ? undefined : forHero(hero.sprite);
    wanted[names.hero(hero.id, "walk")] ??= [own?.walk, heroGeneric.walk];
    wanted[names.hero(hero.id, "idle")] ??= [own?.idle, heroGeneric.idle];
    wanted[names.hero(hero.id, "down")] ??= [own?.down, heroGeneric.down];
  }
  for (const [type, enemy] of content.enemies.entries()) {
    wanted[names.enemy(type)] = [enemy.sprite, generic.enemy];
  }
  for (const weapon of content.weapons) {
    wanted[names.weapon(weapon.id)] ??= [weapon.sprite, generic.bolt];
  }
  return wanted;
};
