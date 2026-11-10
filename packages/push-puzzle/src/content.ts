import { Content } from "arcadekit/content";

import { PuzzleContent } from "./schema";

/**
 * A push-puzzle game's levels: the level Schema, which also checks that every level can be
 * played, and the file they come from. The app provides it from its content source
 * (`PushPuzzleContent.layer(source)`), and anything loads it with `PushPuzzleContent.load`: the
 * first success is kept, and a failed load can be retried. A test reads a game's real files with
 * `PushPuzzleContent.read(source)`, which runs the same checks.
 */
export class PushPuzzleContent extends Content("PushPuzzleContent", {
  schema: PuzzleContent,
  // Paths are relative to the content source.
  files: { levels: "levels.json" },
}) {}
