import { Save } from "arcadekit/save";
import { Schema } from "effect";

// The save: what this game remembers between sessions, per level id. It is UI
// state, not simulation state. The app reads it once at startup and writes it
// when a level is solved, never per frame and never from a step. Storing,
// merging and handling broken storage is arcadekit/save; this file says what a
// level's record holds and how two of them merge.

/** One level's record. `bestMoves` only means something once `solved` is true. */
export const LevelRecord = Schema.Struct({
  solved: Schema.Boolean,
  bestMoves: Schema.Int,
});
export type LevelRecord = typeof LevelRecord.Type;

/** Records by level id. Ids the content no longer has are kept, but not shown. */
export const LevelRecords = Schema.Record(Schema.String, LevelRecord);
export type LevelRecords = typeof LevelRecords.Type;

export const emptyRecords: LevelRecords = {};

/**
 * This game's save. A write merges into what is stored, and `PushPuzzleSave.merge` is that merge
 * with no storage: the best of both sets of records, a level solved if either says so, with the
 * fewer moves. Neither its `read` nor its `write` fails: storage problems are logged and play
 * goes on.
 */
export class PushPuzzleSave extends Save("PushPuzzleSave", {
  storageKey: "arcadekit/push-puzzle/save",
  record: LevelRecord,
  mergeRecord: (a, b) => {
    if (!a.solved) {
      return b;
    }
    if (!b.solved) {
      return a;
    }
    return { solved: true, bestMoves: Math.min(a.bestMoves, b.bestMoves) };
  },
}) {}

/** One solve of `levelId` in `moves` moves, as records: what a solve writes into the save. */
export const solve = (levelId: string, moves: number): LevelRecords => ({
  [levelId]: { solved: true, bestMoves: moves },
});

/** The records after solving `levelId` in `moves` moves. A worse solve keeps the best. */
export const withSolve = (
  records: LevelRecords,
  levelId: string,
  moves: number
): LevelRecords => PushPuzzleSave.merge(records, solve(levelId, moves));

/** True when `moves` beats an earlier solve of `levelId`. A first solve has nothing to beat. */
export const isNewBest = (
  records: LevelRecords,
  levelId: string,
  moves: number
): boolean => {
  const earlier = Object.hasOwn(records, levelId)
    ? records[levelId]
    : undefined;
  return earlier !== undefined && earlier.solved && moves < earlier.bestMoves;
};
