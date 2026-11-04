import { makeSaveStore, mergeRecords as mergeRecordsWith } from "@gamekit/save";
import { Context, Effect, Layer, Schema } from "effect";

// The save: what this game remembers between sessions, per level id. It is UI
// state, not simulation state. The app reads it once at startup and writes it
// when a level is solved, never per frame and never from a step. Storing,
// merging and handling broken storage is @gamekit/save; this file says what a
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

export const SAVE_KEY = "gamekit/push-puzzle/save";

const mergeRecord = (a: LevelRecord, b: LevelRecord): LevelRecord => {
  if (!a.solved) {
    return b;
  }
  if (!b.solved) {
    return a;
  }
  return { solved: true, bestMoves: Math.min(a.bestMoves, b.bestMoves) };
};

/** The best of both: a level is solved if either says so, with the fewer moves. */
export const mergeRecords: (a: LevelRecords, b: LevelRecords) => LevelRecords =
  mergeRecordsWith(mergeRecord);

const solve = (levelId: string, moves: number): LevelRecords => ({
  [levelId]: { solved: true, bestMoves: moves },
});

/** The records after solving `levelId` in `moves` moves. A worse solve keeps the best. */
export const withSolve = (
  records: LevelRecords,
  levelId: string,
  moves: number
): LevelRecords => mergeRecords(records, solve(levelId, moves));

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

/** The save service. Neither method fails: storage problems are logged and play goes on. */
export interface SaveApi {
  /** The stored records. A missing save is empty. A corrupt or unknown-version one is backed up, logged and read as empty. */
  readonly load: Effect.Effect<LevelRecords>;
  /**
   * Records a solve. Re-reads the stored save first and keeps the best of both,
   * so a record another tab wrote isn't lost. Returns the merged records, even
   * when the write fails (that is logged and dropped).
   */
  readonly recordSolve: (
    levelId: string,
    moves: number
  ) => Effect.Effect<LevelRecords>;
}

export class Save extends Context.Service<Save, SaveApi>()(
  "push-puzzle-demo/Save"
) {}

/** The save service over whatever `KeyValueStore` is provided. */
export const SaveLayer = Layer.effect(
  Save,
  Effect.map(
    makeSaveStore({
      key: SAVE_KEY,
      field: "levels",
      record: LevelRecord,
      mergeRecord,
    }),
    (store): SaveApi => ({
      load: store.load,
      recordSolve: (levelId, moves) => store.merge(solve(levelId, moves)),
    })
  )
);
