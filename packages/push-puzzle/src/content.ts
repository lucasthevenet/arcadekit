import { makeContentLoader } from "@gamekit/content";
import type { ContentLoader, ContentSource } from "@gamekit/content";
import { Context, Layer } from "effect";

import { PuzzleContent, findLevelProblems } from "./schema";

/** The file that fills each part of the content. Paths are relative to the content source. */
export const CONTENT_FILES = { levels: "levels.json" } as const;

/** Loads and validates a push-puzzle game's levels. Cached after the first load. */
export class PushPuzzleContent extends Context.Service<
  PushPuzzleContent,
  ContentLoader<PuzzleContent>
>()("@gamekit/push-puzzle/Content") {}

export const makePushPuzzleContentLayer = (source: ContentSource) =>
  Layer.effect(
    PushPuzzleContent,
    makeContentLoader({
      schema: PuzzleContent,
      files: CONTENT_FILES,
      source,
      validate: findLevelProblems,
    })
  );
