import { makeContentLoader } from "@arcadekit/content";
import type {
  ContentDefinition,
  ContentLoader,
  ContentSource,
} from "@arcadekit/content";
import { Context, Layer } from "effect";

import { GameContent } from "./schema";

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
 * The survivors content definition: the schema, which also checks references, and the file each
 * part comes from. The content layer and the tests load it, each with its own source.
 */
export const survivorsContentDefinition: ContentDefinition<typeof GameContent> =
  {
    schema: GameContent,
    files: CONTENT_FILES,
  };

/** Loads and validates a survivors game's content. Keeps the first successful load; a failed one can be retried. */
export class SurvivorsContent extends Context.Service<
  SurvivorsContent,
  ContentLoader<GameContent>
>()("@arcadekit/survivors/Content") {}

export const makeSurvivorsContentLayer = (source: ContentSource) =>
  Layer.effect(
    SurvivorsContent,
    makeContentLoader({ ...survivorsContentDefinition, source })
  );
