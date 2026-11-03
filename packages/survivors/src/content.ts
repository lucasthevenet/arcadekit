import { makeContentLoader } from "@gamekit/content";
import type {
  ContentDefinition,
  ContentLoader,
  ContentSource,
} from "@gamekit/content";
import { Context, Layer } from "effect";

import { GameContent, findBrokenReferences } from "./schema";

/** The file that fills each part of the content. Paths are relative to the content source. */
const CONTENT_FILES = {
  rules: "rules.json",
  heroes: "heroes.json",
  enemies: "enemies.json",
  weapons: "weapons.json",
  passives: "passives.json",
  waves: "waves.json",
} as const;

/**
 * The survivors content definition: the schema, the file each part comes from, and the
 * reference checks. The content layer and the tests load it, each with its own source.
 */
export const survivorsContentDefinition: ContentDefinition<typeof GameContent> =
  {
    schema: GameContent,
    files: CONTENT_FILES,
    validate: findBrokenReferences,
  };

/** Loads and validates a survivors game's content. Cached after the first load. */
export class SurvivorsContent extends Context.Service<
  SurvivorsContent,
  ContentLoader<GameContent>
>()("@gamekit/survivors/Content") {}

export const makeSurvivorsContentLayer = (source: ContentSource) =>
  Layer.effect(
    SurvivorsContent,
    makeContentLoader({ ...survivorsContentDefinition, source })
  );
