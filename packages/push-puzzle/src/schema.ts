import { Schema } from "effect";

import { LEVEL_CHARACTERS, parseLevel } from "./level";

// Levels are text, one string per row, in the standard Sokoban characters plus `^` for a hole:
// `#` wall, space floor, `@` player, `+` player on goal, `$` box, `*` box on goal, `.` goal, `^` hole.

const Id = Schema.String.check(Schema.isNonEmpty());

const unknownCharacter = (level: {
  readonly id: string;
  readonly rows: readonly string[];
}): string | undefined => {
  for (const [index, row] of level.rows.entries()) {
    for (const char of row) {
      if (!LEVEL_CHARACTERS.includes(char)) {
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
  const parsed = parseLevel(level.rows);
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
  // A run can trust a decoded level: it has one player, and boxes for every goal.
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

export const PuzzleContent = Schema.Struct({
  levels: Schema.NonEmptyArray(LevelDef),
}).check(Schema.makeFilter((content) => duplicateIds(content.levels)));
export type PuzzleContent = typeof PuzzleContent.Type;
