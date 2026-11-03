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

export const LevelDef = Schema.Struct({
  id: Id,
  name: Schema.String,
  rows: Schema.NonEmptyArray(Schema.String),
}).check(
  // A filter on the whole level, not the row strings, so the message can name the level.
  Schema.makeFilter((level) => unknownCharacter(level) ?? true)
);
export type LevelDef = typeof LevelDef.Type;

export const PuzzleContent = Schema.Struct({
  levels: Schema.NonEmptyArray(LevelDef),
});
export type PuzzleContent = typeof PuzzleContent.Type;

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/** Finds what the schema can't express: duplicate ids, and levels that can't be played. */
export const findLevelProblems = (
  content: PuzzleContent
): readonly string[] => {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const level of content.levels) {
    const name = `level "${level.id}"`;
    if (seen.has(level.id)) {
      problems.push(`${name} appears more than once`);
    }
    seen.add(level.id);
    const parsed = parseLevel(level.rows);
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
  }
  return problems;
};
