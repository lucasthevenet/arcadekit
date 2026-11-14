import type { SpriteSheet } from "arcadekit/render-three";

import type { GameContent } from "../schema";

// The art a survivors view draws with: one Aseprite sprite sheet, which the app
// provides as the `SurvivorsSheet` asset (game.ts), loaded once and kept for the app's lifetime.
// A view draws from it and never frees it.

/** What a survivors game draws with: the app's loaded sprite sheet. */
export interface SurvivorsArt {
  readonly sheet: SpriteSheet.SpriteSheet;
}

/**
 * The tags the view draws when content names no `sprite`, or one the sheet lacks, and the
 * tags it always draws. White and grey art is tinted: heroes and enemies with their content
 * `color`, projectiles and trails with their weapon's, the marker with its player slot's.
 */
export const SPRITE_TAGS = {
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

/** The three tags a hero draws from its `sprite` prefix (or the generic `hero`). */
export const heroTags = (prefix: string) =>
  ({
    walk: `${prefix}/walk`,
    idle: `${prefix}/idle`,
    down: `${prefix}/down`,
  }) as const;

/**
 * The tags the view draws whatever the content, by the name it reads each under. It picks
 * them once, when it is made.
 */
export const SCENE_TAGS = {
  bolt: SPRITE_TAGS.bolt,
  trail: SPRITE_TAGS.trail,
  gemSmall: SPRITE_TAGS.gems[0],
  gemMedium: SPRITE_TAGS.gems[1],
  gemLarge: SPRITE_TAGS.gems[2],
  aura: SPRITE_TAGS.aura,
  marker: SPRITE_TAGS.marker,
  shadow: SPRITE_TAGS.shadow,
  grass: SPRITE_TAGS.grass,
  patch: SPRITE_TAGS.patch,
  void: SPRITE_TAGS.void,
  ...SPRITE_TAGS.edges,
} as const;

/**
 * The names `contentTags` gives the tags of a content's heroes, enemies and weapons: a hero's
 * and a weapon's by id, as the rules find them, and an enemy's by its place in the content's
 * `enemies`, which is its type in a run.
 */
export const TAG_NAMES = {
  hero: (id: string, part: keyof ReturnType<typeof heroTags>) =>
    `hero ${id} ${part}`,
  enemy: (type: number) => `enemy ${type}`,
  weapon: (id: string) => `weapon ${id}`,
} as const;

/**
 * The tags the view draws for a content's heroes, enemies and weapons, each with what it
 * draws in its place: the `sprite` the content names, then the generic one, which the view
 * tints with the entry's `color`. It picks them once per run.
 */
export const contentTags = (content: GameContent): SpriteSheet.WantedTags => {
  const wanted: Record<string, readonly (string | undefined)[]> = {};
  const generic = heroTags(SPRITE_TAGS.hero);
  // Of two entries with one id, the rules play the first: so does the view.
  for (const hero of content.heroes) {
    const own = hero.sprite === undefined ? undefined : heroTags(hero.sprite);
    wanted[TAG_NAMES.hero(hero.id, "walk")] ??= [own?.walk, generic.walk];
    wanted[TAG_NAMES.hero(hero.id, "idle")] ??= [own?.idle, generic.idle];
    wanted[TAG_NAMES.hero(hero.id, "down")] ??= [own?.down, generic.down];
  }
  for (const [type, enemy] of content.enemies.entries()) {
    wanted[TAG_NAMES.enemy(type)] = [enemy.sprite, SPRITE_TAGS.enemy];
  }
  for (const weapon of content.weapons) {
    wanted[TAG_NAMES.weapon(weapon.id)] ??= [weapon.sprite, SPRITE_TAGS.bolt];
  }
  return wanted;
};

/**
 * Every tag the view draws for `content`, each with the tags it falls back to. A test checks
 * a sheet against its content with it: `SpriteSheet.resolveTags(sheet, wantedTags(content)).missing` lists
 * what the sheet lacks, and the view draws the next choice (or frame 0) in place of each. A
 * generic tag is asked of the sheet only for an entry that names no sprite, or one the sheet
 * lacks: a test that wants them all checks the content with no `sprite` named as well.
 */
export const wantedTags = (content: GameContent): SpriteSheet.WantedTags => ({
  ...SCENE_TAGS,
  ...contentTags(content),
});
