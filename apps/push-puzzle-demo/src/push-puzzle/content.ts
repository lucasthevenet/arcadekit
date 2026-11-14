/**
 * Push-puzzle's content, declared: its levels, and the file they come from.
 *
 * The app provides it from its content source, and a run's config holds what it loads. The
 * Schema it decodes with (`PuzzleContent`) checks that every level can be played.
 */
import { Content } from "arcadekit/content";

import * as PuzzleContent from "./puzzle-content";

/**
 * A push-puzzle game's levels: the level Schema, which also checks that every level can be
 * played, and the file they come from, `levels.json`.
 *
 * **When to use**
 *
 * In an app, to load the levels: provide it with `PushPuzzleContent.layer(source)` and load it with
 * `PushPuzzleContent.load`, on the loading screen. In a test of a game's real files,
 * `PushPuzzleContent.read(source)` runs the same checks and keeps nothing.
 *
 * **Details**
 *
 * The first successful load is kept, and a failed one can be run again. A level that can't be
 * played fails the load with a `ContentSource.ContentError` that names the level.
 *
 * **Example** (Reading a game's levels)
 *
 * ```ts
 * import { PushPuzzleContent } from "../push-puzzle/index";
 * import { ContentSource } from "arcadekit/content";
 * import { Effect } from "effect";
 *
 * const source = ContentSource.fromRecord({
 *   "levels.json": [{ id: "push", name: "Push", rows: ["#####", "#@$.#", "#####"] }],
 * });
 * const content = Effect.runSync(PushPuzzleContent.read(source));
 * content.levels[0].name; // => "Push"
 * ```
 *
 * @category declarations
 */
export class PushPuzzleContent extends Content("PushPuzzleContent", {
  schema: PuzzleContent.PuzzleContent,
  // Paths are relative to the content source.
  files: { levels: "levels.json" },
}) {}
