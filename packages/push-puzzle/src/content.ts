import { makeContentLoader } from "@arcadekit/content";
import type {
  ContentDefinition,
  ContentLoader,
  ContentSource,
} from "@arcadekit/content";
import { Context, Layer } from "effect";

import { PuzzleContent, findLevelProblems } from "./schema";

/** The file that fills each part of the content. Paths are relative to the content source. */
const CONTENT_FILES = { levels: "levels.json" } as const;

/**
 * The push-puzzle content definition: the level schema, the file it comes from, and the
 * level checks. The content layer and the tests load it, each with its own source.
 */
export const pushPuzzleContentDefinition: ContentDefinition<
  typeof PuzzleContent
> = {
  schema: PuzzleContent,
  files: CONTENT_FILES,
  validate: findLevelProblems,
};

/** Loads and validates a push-puzzle game's levels. Keeps the first successful load; a failed one can be retried. */
export class PushPuzzleContent extends Context.Service<
  PushPuzzleContent,
  ContentLoader<PuzzleContent>
>()("@arcadekit/push-puzzle/Content") {}

export const makePushPuzzleContentLayer = (source: ContentSource) =>
  Layer.effect(
    PushPuzzleContent,
    makeContentLoader({ ...pushPuzzleContentDefinition, source })
  );
