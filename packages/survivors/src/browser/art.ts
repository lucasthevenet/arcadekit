import { loadSpriteSheet } from "@gamekit/render-three";
import type {
  SpriteSheet,
  SpriteSheetData,
  SpriteSheetError,
} from "@gamekit/render-three";
import { Context, Duration, Effect, Exit, Layer } from "effect";

import type { GameContent } from "../schema";

// The art a survivors view draws with (ADR-0015): one Aseprite sprite sheet, loaded by the app at
// startup and kept for the app's lifetime. A view draws from it and never frees it.

/** What a survivors game draws with: the app's loaded sprite sheet. */
export interface SurvivorsArt {
  readonly sheet: SpriteSheet;
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
 * Every tag the view would draw for `content` that `sheet` lacks. The view draws the generic
 * sprite (or frame 0) in place of each, so a test can check a sheet against its content.
 */
export const missingSpriteTags = (
  sheet: SpriteSheetData,
  content: GameContent
): readonly string[] => {
  const wanted = new Set<string>([
    ...Object.values(heroTags(SPRITE_TAGS.hero)),
    SPRITE_TAGS.enemy,
    SPRITE_TAGS.bolt,
    SPRITE_TAGS.trail,
    ...SPRITE_TAGS.gems,
    SPRITE_TAGS.aura,
    SPRITE_TAGS.marker,
    SPRITE_TAGS.shadow,
    SPRITE_TAGS.grass,
    SPRITE_TAGS.patch,
    ...Object.values(SPRITE_TAGS.edges),
    SPRITE_TAGS.void,
  ]);
  for (const hero of content.heroes) {
    if (hero.sprite !== undefined) {
      for (const tag of Object.values(heroTags(hero.sprite))) {
        wanted.add(tag);
      }
    }
  }
  for (const def of [...content.enemies, ...content.weapons]) {
    if (def.sprite !== undefined) {
      wanted.add(def.sprite);
    }
  }
  return [...wanted].filter((tag) => !sheet.tags.has(tag));
};

/** Loads the survivors art once. A failed load isn't kept, so calling `load` again retries. */
export interface SurvivorsArtLoader {
  readonly load: Effect.Effect<SurvivorsArt, SpriteSheetError>;
}

/** The app's survivors art. `makeSurvivorsEngineLayer` draws with it; the app loads it at startup. */
export class SurvivorsSprites extends Context.Service<
  SurvivorsSprites,
  SurvivorsArtLoader
>()("@gamekit/survivors/Sprites") {}

/**
 * Provides `SurvivorsSprites`, loading the Aseprite sheet at `sheetUrl` (its JSON) on the first
 * `load`. The sheet lives as long as the layer: the app's lifetime.
 */
export const makeSurvivorsSpritesLayer = (
  sheetUrl: string
): Layer.Layer<SurvivorsSprites> =>
  Layer.effect(
    SurvivorsSprites,
    Effect.gen(function* () {
      let loaded: SpriteSheet | undefined;
      yield* Effect.addFinalizer(() => Effect.sync(() => loaded?.dispose()));
      const load = yield* Effect.cachedWithTTL(
        loadSpriteSheet(sheetUrl).pipe(
          Effect.map((sheet) => {
            loaded = sheet;
            return { sheet };
          })
        ),
        (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero)
      );
      return { load };
    })
  );
