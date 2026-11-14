/**
 * Level records: what the app remembers of each level between sessions, by level id.
 *
 * They are UI state, not simulation state: the app reads them once at startup and writes a solve
 * into them, never per frame and never from a step. `PushPuzzleSave` keeps them, and its record
 * merge says how two records of one level become one.
 *
 * Plain on purpose: Schemas, and the pure functions `update` calls.
 */
import { Schema } from "effect";

/** One level's record. `bestMoves` only means something once `solved` is true. */
export const LevelRecord = Schema.Struct({
  solved: Schema.Boolean,
  bestMoves: Schema.Int,
});

/** One level's record, decoded. */
export type LevelRecord = typeof LevelRecord.Type;

/** Records by level id. Ids the content no longer has are kept, but not shown. */
export const LevelRecords = Schema.Record(Schema.String, LevelRecord);

/** Records by level id, decoded: what the Model holds and the save reads and writes. */
export type LevelRecords = typeof LevelRecords.Type;

/** No records: what the Model holds until the save is read. */
export const empty: LevelRecords = {};

/** One solve of `levelId` in `moves` moves, as records: what a solve writes into the save. */
export const fromSolve = (levelId: string, moves: number): LevelRecords => ({
  [levelId]: { solved: true, bestMoves: moves },
});

/** True when `moves` beats an earlier solve of `levelId` in `self`. A first solve has nothing to beat. */
export const isNewBest = (
  self: LevelRecords,
  levelId: string,
  moves: number
): boolean => {
  const earlier = Object.hasOwn(self, levelId) ? self[levelId] : undefined;
  return earlier !== undefined && earlier.solved && moves < earlier.bestMoves;
};
