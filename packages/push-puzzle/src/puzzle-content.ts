/**
 * Push-puzzle's content as a Schema: its levels, each one checked that it can be played.
 *
 * A level is an id, a name and its rows of text (`Level`). Decoding refuses a level that a run
 * couldn't start on or couldn't finish, and names the level and what is wrong with it, so a run
 * trusts every level it is handed: it has one player, and boxes for every goal. `PushPuzzleContent`
 * loads its file with this Schema.
 *
 * Plain on purpose: the checks are plain functions the Schema calls, pure data work.
 */
import { Schema } from "effect";

import * as Level from "./level";

const Id = Schema.String.check(Schema.isNonEmpty());

const unknownCharacter = (level: {
  readonly id: string;
  readonly rows: readonly string[];
}): string | undefined => {
  for (const [index, row] of level.rows.entries()) {
    for (const char of row) {
      if (!Level.characters.includes(char)) {
        return `level "${level.id}" row ${index + 1} has unknown character "${char}"`;
      }
    }
  }
  return undefined;
};

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/** What makes a level unplayable: not exactly one player, no goal, or too few boxes. */
const playProblems = (level: {
  readonly id: string;
  readonly rows: readonly string[];
}): readonly string[] => {
  const name = `level "${level.id}"`;
  const parsed = Level.parse(level.rows);
  const problems: string[] = [];
  if (parsed.players.length === 0) {
    problems.push(`${name} has no player`);
  } else if (parsed.players.length > 1) {
    problems.push(`${name} has ${parsed.players.length} players`);
  }
  if (parsed.goalCount === 0) {
    problems.push(`${name} has no goal`);
  } else if (parsed.boxes.length < parsed.goalCount) {
    problems.push(
      `${name} has ${plural(parsed.boxes.length, "box", "boxes")} for ${plural(parsed.goalCount, "goal", "goals")}`
    );
  }
  return problems;
};

const LevelDef = Schema.Struct({
  id: Id,
  name: Schema.String,
  rows: Schema.NonEmptyArray(Schema.String),
}).check(
  // Filters on the whole level, not the row strings, so the messages can name the level.
  Schema.makeFilter((level) => unknownCharacter(level) ?? playProblems(level))
);

/** Level ids seen more than once. */
const duplicateIds = (levels: readonly { readonly id: string }[]) => {
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const { id } of levels) {
    if (seen.has(id)) {
      problems.push(`level "${id}" appears more than once`);
    }
    seen.add(id);
  }
  return problems;
};

/**
 * A push-puzzle game's levels, as a Schema: one or more, each with an id, a name and its rows of
 * level text.
 *
 * **When to use**
 *
 * To decode levels a test writes in place, or to check levels without loading them. A game loads
 * its file with `PushPuzzleContent`, which decodes with this Schema.
 *
 * **Details**
 *
 * Decoding refuses a level with a character `Level.characters` lacks, with no player or several,
 * with no goal, or with fewer boxes than goals, and two levels with one id. Each message names the
 * level: `level "first" has no goal`.
 *
 * **Example** (Decoding levels, and refusing one with no goal)
 *
 * ```ts
 * import { PuzzleContent } from "@arcadekit/push-puzzle";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(PuzzleContent.PuzzleContent)({
 *   levels: [{ id: "first", name: "First", rows: ["#####", "#@$.#", "#####"] }],
 * });
 * content.levels[0].id; // => "first"
 * const noGoal = { id: "bare", name: "Bare", rows: ["####", "#@$#", "####"] };
 * Schema.is(PuzzleContent.PuzzleContent)({ levels: [noGoal] }); // => false
 * ```
 *
 * @category schemas
 */
export const PuzzleContent = Schema.Struct({
  levels: Schema.NonEmptyArray(LevelDef),
}).check(Schema.makeFilter((content) => duplicateIds(content.levels)));

/**
 * A push-puzzle game's levels, decoded: what a run's config holds.
 *
 * **When to use**
 *
 * To type the content a run starts from, as `World.Config` does, or a level an app lists.
 *
 * **Example** (Listing the levels' names)
 *
 * ```ts
 * import { PuzzleContent } from "@arcadekit/push-puzzle";
 * import { Schema } from "effect";
 *
 * const content: PuzzleContent.PuzzleContent = Schema.decodeUnknownSync(
 *   PuzzleContent.PuzzleContent
 * )({ levels: [{ id: "first", name: "First", rows: ["#####", "#@$.#", "#####"] }] });
 * content.levels.map((level) => level.name); // => ["First"]
 * ```
 *
 * @category models
 */
export type PuzzleContent = typeof PuzzleContent.Type;
